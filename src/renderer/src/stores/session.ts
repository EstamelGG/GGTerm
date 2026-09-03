import { create } from 'zustand'
import i18next from 'i18next'
import type {
  HostConnection,
  HostStateEvent,
  LinkPhase,
  SftpEntry,
  ShellAnnounceEvent,
  ShellDataEvent,
  ShellStateEvent,
  ShellStatus
} from '@shared/types'
import { errorMessage } from '@shared/error'
import { shellDirectoryCommand } from '@shared/sftpPath'
import type { EncodingMode, FileEncoding } from '@shared/encoding'
import { useSftpStore } from './sftp'
import { useConnectionsStore } from './connections'

/**
 * xterm 注册表按需加载：@xterm/* 体积大且只有终端会话才需要，动态 import
 * 使其脱离首包（配合页面级 lazy）。加载完成前 writeTerminal 按注册顺序排队，零丢失。
 */
let registrySync: typeof import('@/terminal/registry') | null = null
let registryPromise: Promise<typeof import('@/terminal/registry')> | null = null
function loadRegistry(): Promise<typeof import('@/terminal/registry')> {
  return (registryPromise ??= import('@/terminal/registry').then((m) => {
    registrySync = m
    return m
  }))
}

/** 就绪直写；未就绪排队（同一 promise 的 then 回调按注册顺序执行） */
function writeViaRegistry(key: string, data: string): void {
  if (registrySync) registrySync.writeTerminal(key, data)
  else void loadRegistry().then((r) => r.writeTerminal(key, data))
}

/** 对照 ATerminal-Swift SessionCenter.WorkspaceTab */
export type WorkspaceTab =
  | { kind: 'connections' }
  | { kind: 'ai' }
  | { kind: 'host'; id: string }
  /** section：打开设置页时定位的分区（对话页「管理模型」等深链入口） */
  | { kind: 'settings'; section?: 'general' | 'host' | 'ai' | 'about' }
/** 对照 SSHTerminalController 镜像（进程与通道在主进程） */
export interface HostShell {
  id: string
  number: number
  status: ShellStatus
  error?: string
}

/** 对照 RemoteDocument：远程编辑文档（读写经 SFTP） */
export interface RemoteFileDoc {
  encoding: FileEncoding
  encodingMode: EncodingMode
  bom: boolean
  confidence: number
  readOnly: boolean
  id: string
  path: string
  name: string
  /** 远端文件大小（readForEdit 超限判断/下载入口用） */
  size: number
  text: string
  /** 上次保存内容；dirty = text !== saved */
  saved: string
  loading: boolean
  saving: boolean
  error: string | null
}

/** 手动登录勾选"保存"时暂存的凭据；connected 后落盘并清空 */
export interface PendingManualSecrets {
  authType: 'password' | 'privateKey'
  password?: string
  privateKey?: string
  passphrase?: string
}

/** 对照 HostWorkspace 镜像：主机工作区渲染层状态 */
export interface HostWorkspaceMirror {
  id: string
  conn: HostConnection
  title: string
  phase: LinkPhase
  attempt: number
  offlineReason: string
  awaiting: boolean
  pendingSecrets: PendingManualSecrets | null
  shells: HostShell[]
  focusShellId: string | null
  /** 上部编辑区打开的远程编辑文档（上下分栏：与 shell 区独立展示） */
  files: RemoteFileDoc[]
  focusFileId: string | null
}

interface SessionState {
  tab: WorkspaceTab
  hosts: HostWorkspaceMirror[]
  setTab: (tab: WorkspaceTab) => void
  connect: (conn: HostConnection) => Promise<void>
  closeHost: (id: string, agentConnectionIds?: string[]) => void
  detachHost: (id: string) => void
  addShell: (hostId: string, bootstrap?: string) => void
  closeShell: (hostId: string, shellId: string) => void
  focusShell: (hostId: string, shellId: string) => void
  openFile: (hostId: string, entry: SftpEntry) => void
  saveFile: (hostId: string, fileId: string) => Promise<boolean>
  reloadFile: (hostId: string, fileId: string, encoding?: EncodingMode) => void
  closeFile: (hostId: string, fileId: string) => void
  focusFile: (hostId: string, fileId: string) => void
  setFileText: (hostId: string, fileId: string, text: string) => void
  reconnectHost: (hostId: string) => void
  reconnectShell: (hostId: string, shellId: string) => void
  submitAuth: (
    hostId: string,
    cred: {
      username: string
      password?: string
      privateKey?: string
      passphrase?: string
      persist?: boolean
    }
  ) => void
  applyHostState: (e: HostStateEvent) => void
  applyShellState: (e: ShellStateEvent) => void
}

export const isTab = (a: WorkspaceTab, b: WorkspaceTab): boolean =>
  a.kind === b.kind && (a.kind !== 'host' || b.kind !== 'host' || a.id === b.id)

/** 连接级初始执行：initCommand 优先，否则安全生成目录切换命令。 */
function shellInitCommand(conn: HostConnection | undefined): string | undefined {
  if (!conn) return undefined
  if (conn.initCommand?.trim()) return conn.initCommand
  const dir = conn.initDir?.trim()
  if (dir) return shellDirectoryCommand(dir)
  return undefined
}

function nextConsoleNumber(used: number[]): number {
  let n = 1
  while (used.includes(n)) n += 1
  return n
}

/**
 * 早于镜像落地到达的 host:state 事件缓冲（hostId → 最新一条）：
 * hosts:connect 的 handler 在返回前 emitCurrentState，该事件可跑赢 invoke 回复到达，
 * 此时镜像未入 store 会被丢弃——已连接 link 重开 tab 时唯一一次 connected 事件即在此窗口被丢，
 * 镜像永久停在初始 connecting。同通道 IPC 保序，latest 覆盖即可；镜像落地同 tick replay，
 * closeHost 清项防残留污染下次重开。
 */
const pendingHostStates = new Map<string, HostStateEvent>()

/**
 * 早于镜像落地到达的 shell:state 事件缓冲（`${hostId}:${shellId}` → 最新一条）：
 * 与 host:state 同源竞态——addShell 的镜像落库要等 `await loadRegistry()`（首次动态 import xterm），
 * 期间主进程 connectLoop 重建循环 / autoStart 3.5s 兜底可能先发起 start 并发出
 * connecting→connected 事件，渲染层此刻还没有该 shellId 条目，applyShellState 会静默丢弃。
 * latest 覆盖即可；镜像落库同 tick replay；closeShell/closeHost 清项防残留。
 */
const pendingShellStates = new Map<string, ShellStateEvent>()

/** 文档异步操作只更新仍然打开的目标文件，不重新创建已关闭的文档。 */
function patchFile(hostId: string, fileId: string, patch: Partial<RemoteFileDoc>): void {
  useSessionStore.setState((s) => ({
    hosts: s.hosts.map((h) =>
      h.id === hostId
        ? { ...h, files: h.files.map((f) => (f.id === fileId ? { ...f, ...patch } : f)) }
        : h
    )
  }))
}

export const useSessionStore = create<SessionState>((set, get) => ({
  tab: { kind: 'connections' },
  hosts: [],

  setTab: (tab) => set({ tab }),

  connect: async (conn) => {
    const existing = get().hosts.find((h) => h.id === conn.id)
    if (existing) {
      // 已打开：刷新快照并加开一个 shell（对照 SessionCenter.connect 复用分支）
      set((s) => ({
        hosts: s.hosts.map((h) => (h.id === conn.id ? { ...h, conn, title: conn.name } : h))
      }))
      get().addShell(conn.id)
      set({ tab: { kind: 'host', id: conn.id } })
      return
    }
    const { awaiting } = await window.aterm.hosts.connect(conn)
    // 同一主机的并发请求可能一起通过前面的存在性检查；IPC 返回后再次检查。
    // 保留重复连接新增 shell 的既有行为，但工作区只创建一次。
    if (get().hosts.some((h) => h.id === conn.id)) {
      get().addShell(conn.id)
      set({ tab: { kind: 'host', id: conn.id } })
      return
    }
    const host: HostWorkspaceMirror = {
      id: conn.id,
      conn,
      title: conn.name,
      phase: 'connecting',
      attempt: 0,
      offlineReason: '',
      awaiting,
      pendingSecrets: null,
      shells: [],
      focusShellId: null,
      files: [],
      focusFileId: null
    }
    set((s) => ({ hosts: [...s.hosts, host], tab: { kind: 'host', id: conn.id } }))
    // 镜像落地：replay 缓冲里早到的事件（同步执行，必先于后续任何新事件到达）
    const pending = pendingHostStates.get(conn.id)
    if (pending) {
      pendingHostStates.delete(conn.id)
      get().applyHostState(pending)
    }
    get().addShell(conn.id)
  },

  closeHost: (id, agentConnectionIds = []) => {
    window.aterm.hosts.close(id, agentConnectionIds)
    get().detachHost(id)
  },

  detachHost: (id) => {
    pendingHostStates.delete(id) // 清残留缓冲，防旧会话事件 replay 到下次重开
    // 清该主机全部 shell 残留缓冲（防旧会话 shell 事件 replay 到下次重开）
    for (const key of pendingShellStates.keys()) {
      if (key.startsWith(`${id}:`)) pendingShellStates.delete(key)
    }
    useSftpStore.getState().dropHost(id) // SFTP 通道与面板状态随主机关闭（对照 host.sftp.stop）
    const host = get().hosts.find((h) => h.id === id)
    if (host) {
      const keys = host.shells.map((sh) => `${id}:${sh.id}`)
      void loadRegistry().then((r) => keys.forEach((k) => r.disposeTerminal(k)))
    }
    set((s) => ({
      hosts: s.hosts.filter((h) => h.id !== id),
      tab: s.tab.kind === 'host' && s.tab.id === id ? { kind: 'connections' } : s.tab
    }))
  },

  addShell: (hostId, bootstrap) => {
    const host = get().hosts.find((h) => h.id === hostId)
    if (!host) return
    // 初始执行优先级：显式 bootstrap（SFTP"在此打开终端"的 cd）> 连接级 initCommand > initDir 的 cd
    const boot = bootstrap ?? shellInitCommand(host.conn)
    void window.aterm.shells.create(hostId, boot).then(async ({ shellId }) => {
      // 延迟启动协议（对齐本地控制台）：先建 xterm 实例与镜像，再请求主进程开通道
      // —— 之后到达的 state/data 事件必然晚于注册，无竞态
      const { createTerminal } = await loadRegistry()
      createTerminal(`${hostId}:${shellId}`, {
        onData: (d) => window.aterm.shells.input(hostId, shellId, d),
        onResize: (cols, rows) => window.aterm.shells.resize(hostId, shellId, cols, rows)
      })
      const number = nextConsoleNumber(
        get()
          .hosts.find((h) => h.id === hostId)
          ?.shells.map((s) => s.number) ?? []
      )
      set((s) => ({
        hosts: s.hosts.map((h) =>
          h.id === hostId
            ? {
                ...h,
                shells: [...h.shells, { id: shellId, number, status: 'connecting' as ShellStatus }],
                focusShellId: shellId
              }
            : h
        )
      }))
      // 镜像落地：replay 早到缓冲（主进程重建/兜底可能先发状态，此时镜像已落库可正确吸收）
      const pendingKey = `${hostId}:${shellId}`
      const pending = pendingShellStates.get(pendingKey)
      if (pending) {
        pendingShellStates.delete(pendingKey)
        get().applyShellState(pending)
      }
      window.aterm.shells.start(hostId, shellId)
    })
  },

  closeShell: (hostId, shellId) => {
    window.aterm.shells.close(hostId, shellId)
    pendingShellStates.delete(`${hostId}:${shellId}`) // 清残留缓冲，防旧会话事件 replay 到下次
    void loadRegistry().then((r) => r.disposeTerminal(`${hostId}:${shellId}`))
    set((s) => ({
      hosts: s.hosts.map((h) => {
        if (h.id !== hostId) return h
        const shells = h.shells.filter((sh) => sh.id !== shellId)
        return {
          ...h,
          shells,
          focusShellId:
            h.focusShellId === shellId ? (shells[shells.length - 1]?.id ?? null) : h.focusShellId
        }
      })
    }))
  },

  focusShell: (hostId, shellId) => {
    // 上下分栏：会话焦点与文件焦点独立，不再互相清空
    set((s) => ({
      hosts: s.hosts.map((h) => (h.id === hostId ? { ...h, focusShellId: shellId } : h))
    }))
  },

  /** 对照 SessionCenter.openFile：已开聚焦；binary/tooLarge 转下载并提示 */
  openFile: (hostId, entry) => {
    if (entry.isDir) return
    const host = get().hosts.find((h) => h.id === hostId)
    if (!host) return
    const existing = host.files.find((f) => f.path === entry.path)
    if (existing) {
      set((s) => ({
        hosts: s.hosts.map((h) => (h.id === hostId ? { ...h, focusFileId: existing.id } : h))
      }))
      return
    }
    const doc: RemoteFileDoc = {
      encoding: 'utf8',
      encodingMode: 'auto',
      bom: false,
      confidence: 100,
      readOnly: true,
      id: crypto.randomUUID(),
      path: entry.path,
      name: entry.name,
      size: entry.size,
      text: '',
      saved: '',
      loading: true,
      saving: false,
      error: null
    }
    set((s) => ({
      hosts: s.hosts.map((h) =>
        h.id === hostId ? { ...h, files: [...h.files, doc], focusFileId: doc.id } : h
      )
    }))
    void (async () => {
      try {
        const res = await window.aterm.sftp.readForEdit(hostId, entry.path, entry.size)
        if (res.kind === 'text') {
          set((s) => ({
            hosts: s.hosts.map((h) =>
              h.id === hostId
                ? {
                    ...h,
                    files: h.files.map((f) =>
                      f.id === doc.id
                        ? {
                            ...f,
                            text: res.text,
                            saved: res.text,
                            loading: false,
                            encoding: res.encoding,
                            bom: res.bom,
                            confidence: res.confidence,
                            size: res.size,
                            readOnly: res.lossy || res.binary,
                            error: res.binary
                              ? i18next.t('editor.binaryReadOnly')
                              : res.lossy
                                ? i18next.t('editor.lossyReadOnly')
                                : null
                          }
                        : f
                    )
                  }
                : h
            )
          }))
          return
        }
        // 兜底（>10MB 已在 SftpPane 弹窗拦截）：移除标签页并提示改走下载，不自动下载
        set((s) => ({
          hosts: s.hosts.map((h) => {
            if (h.id !== hostId) return h
            const files = h.files.filter((f) => f.id !== doc.id)
            return {
              ...h,
              files,
              focusFileId:
                h.focusFileId === doc.id ? (files[files.length - 1]?.id ?? null) : h.focusFileId
            }
          })
        }))
        useSftpStore.getState().setBanner(hostId, i18next.t('sftp.tooLargeBanner', { limit: 10 }))
      } catch (err) {
        const message = errorMessage(err)
        set((s) => ({
          hosts: s.hosts.map((h) =>
            h.id === hostId
              ? {
                  ...h,
                  files: h.files.map((f) =>
                    f.id === doc.id ? { ...f, loading: false, error: message } : f
                  )
                }
              : h
          )
        }))
      }
    })()
  },

  /** 对照 SessionCenter.saveFile：writeText + saved/error 状态 */
  saveFile: async (hostId, fileId) => {
    const host = get().hosts.find((h) => h.id === hostId)
    const doc = host?.files.find((f) => f.id === fileId)
    if (!host || !doc || doc.saving || doc.loading || doc.readOnly) return false
    if (doc.text === doc.saved) return true
    const text = doc.text
    patchFile(hostId, fileId, { saving: true, error: null })
    try {
      await window.aterm.sftp.writeText(hostId, doc.path, text, doc.encoding, doc.bom)
      patchFile(hostId, fileId, { saving: false, saved: text, error: null })
      return true
    } catch (err) {
      patchFile(hostId, fileId, { saving: false, error: errorMessage(err) })
      return false
    }
  },

  /** 重新拉取远端内容（编辑器"刷新"按钮；dirty 由 UI 层先行确认） */
  reloadFile: (hostId, fileId, encoding) => {
    const host = get().hosts.find((h) => h.id === hostId)
    const doc = host?.files.find((f) => f.id === fileId)
    if (!host || !doc || doc.loading || doc.saving) return
    const patch = (p: Partial<RemoteFileDoc>): void => patchFile(hostId, fileId, p)
    patch({ loading: true, error: null })
    void (async () => {
      try {
        const mode = encoding ?? doc.encodingMode
        const res = await window.aterm.sftp.readForEdit(hostId, doc.path, doc.size, mode)
        if (res.kind === 'text') {
          patch({
            text: res.text,
            saved: res.text,
            loading: false,
            encoding: res.encoding,
            encodingMode: mode,
            bom: res.bom,
            confidence: res.confidence,
            size: res.size,
            readOnly: res.lossy || res.binary,
            error: res.binary
              ? i18next.t('editor.binaryReadOnly')
              : res.lossy
                ? i18next.t('editor.lossyReadOnly')
                : null
          })
          return
        }
        patch({ loading: false, error: i18next.t('sftp.tooLargeBanner', { limit: 10 }) })
      } catch (err) {
        patch({ loading: false, error: errorMessage(err) })
      }
    })()
  },

  /** 对照 SessionCenter.closeFile：焦点回退到最后一个文件或 shell */
  closeFile: (hostId, fileId) => {
    set((s) => ({
      hosts: s.hosts.map((h) => {
        if (h.id !== hostId) return h
        const files = h.files.filter((f) => f.id !== fileId)
        return {
          ...h,
          files,
          focusFileId:
            h.focusFileId === fileId ? (files[files.length - 1]?.id ?? null) : h.focusFileId
        }
      })
    }))
  },

  focusFile: (hostId, fileId) => {
    // 上下分栏：文件焦点与会话焦点独立，不再互相清空
    set((s) => ({
      hosts: s.hosts.map((h) => (h.id === hostId ? { ...h, focusFileId: fileId } : h))
    }))
  },

  setFileText: (hostId, fileId, text) => patchFile(hostId, fileId, { text }),

  reconnectHost: (hostId) => {
    window.aterm.hosts.reconnect(hostId)
  },

  reconnectShell: (hostId, shellId) => {
    window.aterm.shells.restart(hostId, shellId)
  },

  submitAuth: (hostId, { username, password, privateKey, passphrase, persist }) => {
    window.aterm.hosts.submitAuth(hostId, { username, password, privateKey, passphrase })
    set((s) => ({
      hosts: s.hosts.map((h) =>
        h.id === hostId
          ? {
              ...h,
              awaiting: false,
              conn: { ...h.conn, username },
              pendingSecrets: persist
                ? {
                    authType: privateKey ? 'privateKey' : 'password',
                    password,
                    privateKey,
                    passphrase: privateKey ? passphrase : undefined
                  }
                : null
            }
          : h
      )
    }))
  },

  applyHostState: (e) => {
    // 镜像尚未落地（事件跑赢了 hosts:connect 的 invoke 回复）：入缓冲，connect() 落地镜像后 replay
    if (!get().hosts.some((h) => h.id === e.hostId)) {
      pendingHostStates.set(e.hostId, e)
      return
    }
    // 手动登录勾选"保存"：认证通过（connected）才落盘——凭据错误到不了这里
    const target = get().hosts.find((h) => h.id === e.hostId)
    if (e.phase === 'connected' && target?.pendingSecrets) {
      const { username } = target.conn
      const p = target.pendingSecrets
      void (async () => {
        await useConnectionsStore.getState().update(e.hostId, { authType: p.authType, username })
        // 只写本次手动登录用到的凭据字段，不覆盖另一侧已存内容
        await window.aterm.secrets.save(
          e.hostId,
          p.authType === 'password'
            ? { password: p.password ?? '' }
            : { privateKey: p.privateKey ?? '', passphrase: p.passphrase ?? '' }
        )
      })()
    }
    set((s) => ({
      hosts: s.hosts.map((h) =>
        h.id === e.hostId
          ? {
              ...h,
              phase: e.phase,
              attempt: e.attempt ?? h.attempt,
              offlineReason: e.reason ?? h.offlineReason,
              awaiting: e.awaiting ?? h.awaiting,
              pendingSecrets: e.phase === 'connected' ? null : h.pendingSecrets,
              conn:
                e.phase === 'connected' && h.conn.authType === 'manual' && h.pendingSecrets
                  ? { ...h.conn, authType: h.pendingSecrets.authType }
                  : h.conn
            }
          : h
      )
    }))
  },

  applyShellState: (e) => {
    // 镜像尚未落地（事件跑赢了 addShell 的镜像落库）：入缓冲，落库后 replay，避免静默丢弃
    const host = get().hosts.find((h) => h.id === e.hostId)
    if (!host || !host.shells.some((sh) => sh.id === e.shellId)) {
      pendingShellStates.set(`${e.hostId}:${e.shellId}`, e)
      return
    }
    set((s) => ({
      hosts: s.hosts.map((h) =>
        h.id === e.hostId
          ? {
              ...h,
              shells: h.shells.map((sh) =>
                sh.id === e.shellId ? { ...sh, status: e.status, error: e.error } : sh
              )
            }
          : h
      )
    }))
  }
}))

/** 远程 shell 输出/公告管道 */
export function pumpShellData(e: ShellDataEvent): void {
  writeViaRegistry(`${e.hostId}:${e.shellId}`, e.data)
}

export function pumpShellAnnounce(e: ShellAnnounceEvent): void {
  writeViaRegistry(`${e.hostId}:${e.shellId}`, `\r\n\x1b[1;33m〔${e.text}〕\x1b[0m\r\n`)
}
