import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { EncodingMode, FileEncoding } from '../shared/encoding'
import type {
  AppLogEntry,
  AppPreferencesData,
  AiEvent,
  AiSessionSummary,
  AiUIMessage,
  ConnectionSecrets,
  HostConnection,
  HostGroup,
  HostLinkSnapshot,
  HostStateEvent,
  LocaleChangedEvent,
  LocalePref,
  LocalSshKey,
  OsSampleEvent,
  PerfGpuSample,
  PerfSample,
  ServerNote,
  SftpEditPayload,
  SftpEntry,
  SftpListing,
  SftpMeasureEvent,
  SftpStateEvent,
  SftpStat,
  SftpTransferEvent,
  ShellAnnounceEvent,
  ShellDataEvent,
  ShellStateEvent,
  SshConfigHost,
  SshConnectionSession
} from '../shared/types'
import type { ProtectedFolder } from '../shared/localAccess'
import type { SshTestInput } from '../main/sshTest'
import type { ExecutionSnapshot, HumanInputRequest, HumanInputResolved } from '../shared/execution'

/* 启动外观：main 经 additionalArguments 传入已存 accent / 背景透明度，在任何渲染脚本执行前
   设置 CSS 变量（逻辑与 renderer lib/accent.ts 保持一致），避免首帧「默认值 → 保存值」闪变。
   preload 执行时机早于 DOM 构建（documentElement 可能为 null）：就地应用，否则推迟到 DOMContentLoaded */
{
  const applyStartupAppearance = (): void => {
    try {
      const root = document.documentElement?.style
      if (!root) return
      const readArg = (name: string): string | null => {
        const arg = process.argv.find((a) => a.startsWith(`${name}=`))
        return arg ? arg.slice(name.length + 1).trim() : null
      }
      const m = /^#?([0-9a-fA-F]{6})$/.exec(readArg('--pref-accent') ?? '')
      if (m) {
        const n = parseInt(m[1], 16)
        const r = (n >> 16) & 0xff
        const g = (n >> 8) & 0xff
        const b = n & 0xff
        root.setProperty('--at-accent', `#${m[1]}`)
        root.setProperty(
          '--at-accent-dim',
          `rgb(${Math.round(r * 0.78)} ${Math.round(g * 0.78)} ${Math.round(b * 0.78)})`
        )
        root.setProperty('--at-accent-rgb', `${r} ${g} ${b}`)
      }
      // 背景透明度 0–100：100 = 设计默认层次，0 = 完全实色；缺省 100 = 不改动设计层次
      const raw = Number(readArg('--pref-bg-transparency'))
      const t = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 100
      root.setProperty('--at-surface-mix', String(t / 100))
    } catch {
      /* 外观预注入失败不影响启动：prefs 加载后 applyAccent/applyBgTransparency 会再次应用 */
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyStartupAppearance, { once: true })
  } else {
    applyStartupAppearance()
  }
}

/** 渲染进程可用的 API（对照 Swift 层：SwiftData/Keychain/UserDefaults 通道） */
const api = {
  executions: {
    list: (sessionId: string, hostId?: string): Promise<ExecutionSnapshot[]> =>
      ipcRenderer.invoke('execution:list', sessionId, hostId),
    read: (sessionId: string, id: string, cursor: number): Promise<ExecutionSnapshot> =>
      ipcRenderer.invoke('execution:read', sessionId, id, cursor),
    terminate: (sessionId: string, id: string): Promise<void> =>
      ipcRenderer.invoke('execution:terminate', sessionId, id)
  },
  /**
   * 人工输入（敏感提示）通道：独立于只读查看器 API。
   * 卡片提交的值由主进程直写 PTY，不经模型 / 不落盘 / 不进输出缓冲。
   */
  humanInput: {
    /** 未收尾的待办（启动或刷新后恢复卡片） */
    list: (sessionId?: string): Promise<HumanInputRequest[]> =>
      ipcRenderer.invoke('human-input:list', sessionId),
    submit: (sessionId: string, executionId: string, value: string): Promise<void> =>
      ipcRenderer.invoke('human-input:submit', sessionId, executionId, value),
    cancel: (sessionId: string, executionId: string): Promise<void> =>
      ipcRenderer.invoke('human-input:cancel', sessionId, executionId),
    onRequest: (cb: (request: HumanInputRequest) => void): (() => void) => {
      const listener = (_e: unknown, request: HumanInputRequest): void => cb(request)
      ipcRenderer.on('human-input:request', listener)
      return () => ipcRenderer.removeListener('human-input:request', listener)
    },
    onResolved: (cb: (info: HumanInputResolved) => void): (() => void) => {
      const listener = (_e: unknown, info: HumanInputResolved): void => cb(info)
      ipcRenderer.on('human-input:resolved', listener)
      return () => ipcRenderer.removeListener('human-input:resolved', listener)
    }
  },
  window: {
    platform: process.platform,
    confirmClose: (): void => ipcRenderer.send('app:confirm-close'),
    onCloseRequest: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('app:request-close', listener)
      ipcRenderer.send('app:close-ready')
      return () => ipcRenderer.removeListener('app:request-close', listener)
    }
  },
  connections: {
    list: (): Promise<HostConnection[]> => ipcRenderer.invoke('conn:list'),
    create: (
      input: Partial<HostConnection> & Pick<HostConnection, 'name' | 'host' | 'username'>
    ): Promise<HostConnection> => ipcRenderer.invoke('conn:create', input),
    update: (id: string, patch: Partial<HostConnection>): Promise<HostConnection | null> =>
      ipcRenderer.invoke('conn:update', { id, patch }),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('conn:delete', id),
    setNote: (id: string, note: ServerNote): Promise<HostConnection | null> =>
      ipcRenderer.invoke('conn:setNote', { id, note }),
    /** 任意来源（表单/agent tool/导入）增删改后的全量快照推送 */
    onChange: (
      cb: (payload: { connections: HostConnection[]; groups: HostGroup[] }) => void
    ): (() => void) => {
      const listener = (
        _e: unknown,
        payload: { connections: HostConnection[]; groups: HostGroup[] }
      ): void => cb(payload)
      ipcRenderer.on('connections:changed', listener)
      return () => ipcRenderer.removeListener('connections:changed', listener)
    }
  },
  groups: {
    list: (): Promise<HostGroup[]> => ipcRenderer.invoke('group:list'),
    create: (input: Partial<HostGroup> & Pick<HostGroup, 'name'>): Promise<HostGroup> =>
      ipcRenderer.invoke('group:create', input),
    update: (id: string, patch: Partial<HostGroup>): Promise<HostGroup | null> =>
      ipcRenderer.invoke('group:update', { id, patch }),
    remove: (id: string): Promise<{ removed: string[]; ungrouped: number } | null> =>
      ipcRenderer.invoke('group:delete', id)
  },
  secrets: {
    save: (id: string, secrets: Partial<ConnectionSecrets>): Promise<void> =>
      ipcRenderer.invoke('secrets:save', { id, secrets }),
    load: (id: string): Promise<ConnectionSecrets> => ipcRenderer.invoke('secrets:load', id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('secrets:delete', id)
  },
  prefs: {
    get: (): Promise<AppPreferencesData> => ipcRenderer.invoke('prefs:get'),
    onChanged: (cb: (p: AppPreferencesData) => void): (() => void) => {
      const listener = (_e: unknown, p: AppPreferencesData): void => cb(p)
      ipcRenderer.on('prefs:changed', listener)
      return () => ipcRenderer.removeListener('prefs:changed', listener)
    },
    set: (patch: Partial<AppPreferencesData>): Promise<AppPreferencesData> =>
      ipcRenderer.invoke('prefs:set', patch)
  },
  locale: {
    /** 初始语言：pref = 用户偏好（auto 跟随系统），locale = 解析后生效值 */
    get: (): Promise<{ pref: LocalePref; locale: Exclude<LocalePref, 'auto'> }> =>
      ipcRenderer.invoke('locale:get'),
    /** 切换偏好；主进程换语言并广播 locale:changed */
    set: (pref: LocalePref): Promise<{ pref: LocalePref; locale: Exclude<LocalePref, 'auto'> }> =>
      ipcRenderer.invoke('locale:set', pref),
    onChanged: (cb: (payload: LocaleChangedEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: LocaleChangedEvent): void => cb(payload)
      ipcRenderer.on('locale:changed', listener)
      return () => ipcRenderer.removeListener('locale:changed', listener)
    }
  },
  probe: {
    /** 批量 TCP 延迟探测；ms 为 null 表示不可达 */
    latency: (
      targets: { id: string; host: string; port: number }[]
    ): Promise<{ id: string; ms: number | null }[]> => ipcRenderer.invoke('probe:latency', targets)
  },
  perf: {
    /** 最近样本快照（含已连接与 hub 探测主机）；后续增量走 onSample 事件 */
    snapshot: (): Promise<Record<string, PerfSample>> => ipcRenderer.invoke('perf:snapshot'),
    /** 连接列表页可见行集合全量同步（IntersectionObserver 驱动） */
    watch: (hostIds: string[]): void => ipcRenderer.send('perf:watch', hostIds),
    /** 列表头手动刷新：清熔断 + 立即采样（成功即恢复自动周期） */
    refresh: (): void => ipcRenderer.send('perf:refresh'),
    /** 性能列隐藏时暂停采样计时器（探测连接与已显示样本保留；恢复可见按原间隔续跑） */
    setPaused: (paused: boolean): void => ipcRenderer.send('perf:setPaused', paused),
    /** 会话页活动栏面板：独立会话采样（借用会话共享连接；null = 停止） */
    watchSession: (hostId: string | null): void => ipcRenderer.send('perf:watchSession', hostId),
    /** GPU 专用低频样本（与 onSample 分开两条流：节奏不同，合并会把“本轮没采”误读成“没有 GPU”） */
    onGpu: (cb: (payload: PerfGpuSample) => void): (() => void) => {
      const listener = (_e: unknown, payload: PerfGpuSample): void => cb(payload)
      ipcRenderer.on('perf:gpu', listener)
      return () => ipcRenderer.removeListener('perf:gpu', listener)
    },
    onSample: (cb: (payload: PerfSample) => void): (() => void) => {
      const listener = (_e: unknown, payload: PerfSample): void => cb(payload)
      ipcRenderer.on('perf:sample', listener)
      return () => ipcRenderer.removeListener('perf:sample', listener)
    },
    /** SSH 会话链路建立后的主机系统名单次采集（OS 图标缓存兜底刷新路径） */
    onOs: (cb: (payload: OsSampleEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: OsSampleEvent): void => cb(payload)
      ipcRenderer.on('os:sample', listener)
      return () => ipcRenderer.removeListener('os:sample', listener)
    },
    /** 对指定主机手动触发系统名单次采集（结果经 os:sample 回流缓存） */
    probeOs: (hostIds: string[]): void => ipcRenderer.send('os:probe', { hostIds })
  },
  ssh: {
    /** 真实建连测试：成功 resolve，失败 reject */
    test: (input: SshTestInput): Promise<void> => ipcRenderer.invoke('ssh:test', input)
  },
  localSsh: {
    /** 列 ~/.ssh 下的私钥（读内容验证过） */
    listKeys: (): Promise<LocalSshKey[]> => ipcRenderer.invoke('localKeys:list'),
    /** 读私钥内容（限定家目录内 + 内容验证） */
    readKey: (path: string): Promise<string> => ipcRenderer.invoke('localKeys:read', path),
    /** 解析 ~/.ssh/config 为主机条目（文件缺失返回空数组） */
    parseConfig: (): Promise<SshConfigHost[]> => ipcRenderer.invoke('sshConfig:parse')
  },
  hosts: {
    connect: (conn: HostConnection): Promise<{ awaiting: boolean }> =>
      ipcRenderer.invoke('host:connect', conn),
    /** 全部链路状态快照（拓扑图初始化：phase + 进入时刻 + 重试次数 + 失败原因） */
    listLinks: (): Promise<HostLinkSnapshot[]> => ipcRenderer.invoke('links:list'),
    submitAuth: (
      hostId: string,
      cred: { username: string; password?: string; privateKey?: string; passphrase?: string }
    ): void => ipcRenderer.send('host:submitAuth', { hostId, ...cred }),
    reconnect: (hostId: string): void => ipcRenderer.send('host:reconnect', hostId),
    restart: (hostId: string): void => ipcRenderer.send('host:restart', hostId),
    close: (hostId: string, agentConnectionIds: string[] = []): void =>
      ipcRenderer.send('host:close', hostId, agentConnectionIds),
    connectionSessions: (hostIds: string[]): Promise<SshConnectionSession[]> =>
      ipcRenderer.invoke('host:connectionSessions', hostIds),
    listAgentLinks: (): Promise<SshConnectionSession[]> => ipcRenderer.invoke('agent:links'),
    closeConnections: (hostId: string, ids: string[]): Promise<{ userClosed: boolean }> =>
      ipcRenderer.invoke('host:closeConnections', hostId, ids),
    onAgentState: (cb: (payload: SshConnectionSession) => void): (() => void) => {
      const listener = (_e: unknown, payload: SshConnectionSession): void => cb(payload)
      ipcRenderer.on('agent:host:state', listener)
      return () => ipcRenderer.removeListener('agent:host:state', listener)
    },
    onState: (cb: (payload: HostStateEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: HostStateEvent): void => cb(payload)
      ipcRenderer.on('host:state', listener)
      return () => ipcRenderer.removeListener('host:state', listener)
    }
  },
  logs: {
    list: (): Promise<AppLogEntry[]> => ipcRenderer.invoke('app:logs'),
    push: (category: string, message: string): void =>
      ipcRenderer.send('app:log-push', { category, message }),
    clear: (): void => ipcRenderer.send('app:log-clear'),
    onLog: (cb: (entry: AppLogEntry) => void): (() => void) => {
      const listener = (_e: unknown, entry: AppLogEntry): void => cb(entry)
      ipcRenderer.on('app:log', listener)
      return () => ipcRenderer.removeListener('app:log', listener)
    },
    onOpen: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('app:open-logs', listener)
      return () => ipcRenderer.removeListener('app:open-logs', listener)
    }
  },
  shells: {
    create: (hostId: string, bootstrap?: string): Promise<{ shellId: string }> =>
      ipcRenderer.invoke('shell:create', { hostId, bootstrap }),
    start: (hostId: string, shellId: string): void =>
      ipcRenderer.send('shell:start', { hostId, shellId }),
    input: (hostId: string, shellId: string, data: string): void =>
      ipcRenderer.send('shell:input', { hostId, shellId, data }),
    resize: (hostId: string, shellId: string, cols: number, rows: number): void =>
      ipcRenderer.send('shell:resize', { hostId, shellId, cols, rows }),
    close: (hostId: string, shellId: string): void =>
      ipcRenderer.send('shell:close', { hostId, shellId }),
    restart: (hostId: string, shellId: string): void =>
      ipcRenderer.send('shell:restart', { hostId, shellId }),
    onState: (cb: (payload: ShellStateEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: ShellStateEvent): void => cb(payload)
      ipcRenderer.on('shell:state', listener)
      return () => ipcRenderer.removeListener('shell:state', listener)
    },
    onData: (cb: (payload: ShellDataEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: ShellDataEvent): void => cb(payload)
      ipcRenderer.on('shell:data', listener)
      return () => ipcRenderer.removeListener('shell:data', listener)
    },
    onAnnounce: (cb: (payload: ShellAnnounceEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: ShellAnnounceEvent): void => cb(payload)
      ipcRenderer.on('shell:announce', listener)
      return () => ipcRenderer.removeListener('shell:announce', listener)
    }
  },
  ai: {
    listSessions: (): Promise<AiSessionSummary[]> => ipcRenderer.invoke('ai:listSessions'),
    createSession: (): Promise<AiSessionSummary> => ipcRenderer.invoke('ai:createSession'),
    getMessages: (sessionId: string): Promise<AiUIMessage[]> =>
      ipcRenderer.invoke('ai:getMessages', { sessionId }),
    closeSession: (sessionId: string): void => ipcRenderer.send('ai:closeSession', { sessionId }),
    run: (sessionId: string, messages: AiUIMessage[]): Promise<void> =>
      ipcRenderer.invoke('ai:run', { sessionId, messages }),
    cancel: (sessionId: string): void => ipcRenderer.send('ai:cancel', { sessionId }),
    listModels: (providerId: string): Promise<string[]> =>
      ipcRenderer.invoke('ai:listModels', { providerId }),
    hasApiKey: (profileId: string): Promise<boolean> =>
      ipcRenderer.invoke('ai:hasApiKey', profileId),
    setApiKey: (profileId: string, apiKey: string): Promise<void> =>
      ipcRenderer.invoke('ai:setApiKey', { profileId, apiKey }),
    onEvent: (cb: (event: AiEvent) => void): (() => void) => {
      const listener = (_e: unknown, event: AiEvent): void => cb(event)
      ipcRenderer.on('ai:event', listener)
      return () => ipcRenderer.removeListener('ai:event', listener)
    }
  },
  sftp: {
    start: (hostId: string): Promise<void> => ipcRenderer.invoke('sftp:start', hostId),
    stop: (hostId: string): void => ipcRenderer.send('sftp:stop', hostId),
    list: (hostId: string, path: string): Promise<SftpListing> =>
      ipcRenderer.invoke('sftp:list', { hostId, path }),
    realpath: (hostId: string, path: string): Promise<string> =>
      ipcRenderer.invoke('sftp:realpath', { hostId, path }),
    readlink: (hostId: string, path: string): Promise<string> =>
      ipcRenderer.invoke('sftp:readlink', { hostId, path }),
    itemDetail: (hostId: string, path: string): Promise<SftpStat> =>
      ipcRenderer.invoke('sftp:itemDetail', { hostId, path }),
    exists: (hostId: string, path: string): Promise<boolean> =>
      ipcRenderer.invoke('sftp:exists', { hostId, path }),
    isDirectory: (hostId: string, path: string): Promise<boolean> =>
      ipcRenderer.invoke('sftp:isDirectory', { hostId, path }),
    mkdir: (hostId: string, path: string): Promise<void> =>
      ipcRenderer.invoke('sftp:mkdir', { hostId, path }),
    touch: (hostId: string, path: string): Promise<void> =>
      ipcRenderer.invoke('sftp:touch', { hostId, path }),
    rename: (hostId: string, src: string, dest: string): Promise<void> =>
      ipcRenderer.invoke('sftp:rename', { hostId, src, dest }),
    chmod: (hostId: string, path: string, mode: number): Promise<void> =>
      ipcRenderer.invoke('sftp:chmod', { hostId, path, mode }),
    readForEdit: (
      hostId: string,
      path: string,
      size: number,
      encoding: EncodingMode = 'auto'
    ): Promise<SftpEditPayload> =>
      ipcRenderer.invoke('sftp:readForEdit', { hostId, path, size, encoding }),
    writeText: (
      hostId: string,
      path: string,
      text: string,
      encoding: FileEncoding,
      bom: boolean
    ): Promise<void> => ipcRenderer.invoke('sftp:writeText', { hostId, path, text, encoding, bom }),
    remove: (hostId: string, entry: SftpEntry): Promise<void> =>
      ipcRenderer.invoke('sftp:remove', { hostId, entry }),
    /** 后台任务：进度/错误经 onTransfer 事件广播 */
    download: (hostId: string, entry: SftpEntry): void =>
      void ipcRenderer.invoke('sftp:download', { hostId, entry }),
    upload: (hostId: string, localPaths: string[], destDir: string): void =>
      void ipcRenderer.invoke('sftp:upload', { hostId, localPaths, destDir }),
    measure: (hostId: string, path: string): void =>
      void ipcRenderer.invoke('sftp:measure', { hostId, path }),
    measureCancel: (hostId: string): void => ipcRenderer.send('sftp:measureCancel', hostId),
    /** 取消任务的字节流及专用通道 */
    cancelTransfer: (hostId: string, transferId: string): void =>
      ipcRenderer.send('sftp:transferCancel', { hostId, transferId }),
    retryCleanup: (hostId: string, transferId: string): void =>
      ipcRenderer.send('sftp:retryCleanup', { hostId, transferId }),
    pickLocal: (folders: boolean): Promise<string[]> =>
      ipcRenderer.invoke('sftp:pickLocal', folders),
    revealDownloads: (): void => {
      void ipcRenderer.invoke('sftp:revealDownloads')
    },
    revealLocal: (path: string, isDir: boolean): Promise<void> =>
      ipcRenderer.invoke('sftp:revealLocal', { path, isDir }),
    onState: (cb: (payload: SftpStateEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: SftpStateEvent): void => cb(payload)
      ipcRenderer.on('sftp:state', listener)
      return () => ipcRenderer.removeListener('sftp:state', listener)
    },
    onTransfer: (cb: (payload: SftpTransferEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: SftpTransferEvent): void => cb(payload)
      ipcRenderer.on('sftp:transfer', listener)
      return () => ipcRenderer.removeListener('sftp:transfer', listener)
    },
    onMeasure: (cb: (payload: SftpMeasureEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: SftpMeasureEvent): void => cb(payload)
      ipcRenderer.on('sftp:measure', listener)
      return () => ipcRenderer.removeListener('sftp:measure', listener)
    },
    /** 外部拖入文件 → 本地绝对路径（Electron 渲染层 File 对象专用） */
    pathForFile: (file: File): string => webUtils.getPathForFile(file)
  },
  localAccess: {
    openPrivacySettings: (folder: ProtectedFolder): Promise<void> =>
      ipcRenderer.invoke('localAccess:openSettings', folder)
  }
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('aterm', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.aterm = api
}
