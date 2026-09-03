import { create } from 'zustand'
import type {
  SftpEntry,
  SftpStateEvent,
  SftpStatus,
  SftpTransferEvent,
  SftpTransferMirror
} from '@shared/types'
import { isUnderPath, joinPath, normalizePath, parentPath } from '@shared/sftpPath'
import { errorMessage } from '@shared/error'
import { useConnectionsStore } from './connections'

/**
 * 对照 ATerminal-Swift SftpController.swift 的树状态（渲染层 zustand 版）：
 * children 缓存 / expanded / showHidden / reveal 逐级展开 / 传输镜像。
 * 主进程只做无状态 IPC 操作；断线/恢复由 sftp:state + host:state 事件驱动。
 */

export interface SftpPaneState {
  started: boolean
  status: SftpStatus
  error: string | null
  /** 可见树根：/ 可列时用 /，否则回退 home（对照 root） */
  root: string
  home: string
  path: string
  children: Record<string, SftpEntry[]>
  /** 目录级列目录错误（路径 → 消息）：树内以红色占位行呈现，不再占用底部 banner */
  errors: Record<string, string>
  expanded: string[]
  showHidden: boolean
  loadingPaths: string[]
  loading: boolean
  banner: string | null
  transfers: SftpTransferMirror[]
  focusedPath: string | null
}

const EMPTY_PANE: Omit<SftpPaneState, never> = {
  started: false,
  status: 'connecting',
  error: null,
  root: '/',
  home: '/',
  path: '/',
  children: {},
  errors: {},
  expanded: [],
  showHidden: true,
  loadingPaths: [],
  loading: false,
  banner: null,
  transfers: [],
  focusedPath: null
}

interface SftpStoreState {
  panes: Record<string, SftpPaneState>
  /** HostSessionPage 挂载时调用（幂等）：开通道 + connectAndList（链路等待在主进程 sftp:start 内） */
  ensureStarted: (hostId: string) => void
  dropHost: (hostId: string) => void
  reconnect: (hostId: string) => void
  refresh: (hostId: string) => void
  goHome: (hostId: string) => void
  go: (hostId: string, raw: string) => void
  toggleHidden: (hostId: string) => void
  toggle: (hostId: string, entry: SftpEntry) => void
  collapseAll: (hostId: string) => void
  select: (hostId: string, entry: SftpEntry) => void
  mkdir: (hostId: string, name: string, into?: string) => Promise<void>
  touch: (hostId: string, name: string, into?: string) => Promise<void>
  rename: (hostId: string, entry: SftpEntry, name: string) => Promise<void>
  move: (hostId: string, entry: SftpEntry, destDir: string) => Promise<void>
  chmod: (hostId: string, entry: SftpEntry, mode: number) => Promise<void>
  remove: (hostId: string, entry: SftpEntry) => Promise<void>
  download: (hostId: string, entry: SftpEntry) => void
  upload: (hostId: string, localPaths: string[], destDir: string) => void
  setBanner: (hostId: string, text: string | null) => void
  applyStateEvent: (e: SftpStateEvent) => void
  applyTransferEvent: (e: SftpTransferEvent) => void
  /** 活动栏传输面板：清除非 running 镜像（hostId 省略 = 全部主机） */
  clearFinished: (hostId?: string) => void
}

export const useSftpStore = create<SftpStoreState>((set, get) => {
  const pane = (hostId: string): SftpPaneState => get().panes[hostId] ?? EMPTY_PANE

  const patch = (hostId: string, p: Partial<SftpPaneState>): void => {
    set((s) => {
      const base = s.panes[hostId] ?? EMPTY_PANE
      return { panes: { ...s.panes, [hostId]: { ...base, ...p } } }
    })
  }

  /** 单目录重载（对照 load；resolved 键双写 + expanded 键替换）；失败记入 errors（树内红行），日志由主进程记录 */
  const load = async (hostId: string, target: string): Promise<string | null> => {
    patch(hostId, { loadingPaths: [...pane(hostId).loadingPaths, target] })
    try {
      const { resolved, entries } = await window.aterm.sftp.list(hostId, target)
      const p = pane(hostId)
      const children = { ...p.children, [resolved]: entries }
      if (target !== resolved) {
        children[target] = entries
        if (p.expanded.includes(target)) {
          p.expanded = p.expanded.map((x) => (x === target ? resolved : x))
        }
      }
      const restErrors = { ...p.errors }
      delete restErrors[target]
      patch(hostId, {
        children,
        expanded: p.expanded,
        home: target === p.home ? resolved : p.home,
        path: p.path === target ? resolved : p.path,
        banner: null,
        errors: restErrors,
        status: 'connected'
      })
      void resolveLinkTargets(hostId, resolved, entries)
      return resolved
    } catch (err) {
      const p = pane(hostId)
      patch(hostId, { errors: { ...p.errors, [target]: errorMessage(err) } })
      return null
    } finally {
      patch(hostId, { loadingPaths: pane(hostId).loadingPaths.filter((x) => x !== target) })
    }
  }

  /** 大目录链接目标补全（对照 resolveLinkTargets：≤64 链接、≤500 项；10 个一组并发） */
  const resolveLinkTargets = async (
    hostId: string,
    dir: string,
    entries: SftpEntry[]
  ): Promise<void> => {
    const pending = entries.filter((e) => e.isLink && !e.linkTarget)
    if (pending.length === 0 || pending.length > 64 || entries.length > 500) return
    let changed = false
    const next = entries.map((e) => ({ ...e }))
    const CONC = 10
    for (let i = 0; i < next.length; i += CONC) {
      await Promise.all(
        next.slice(i, i + CONC).map(async (e) => {
          if (!e.isLink || e.linkTarget) return
          const target = await window.aterm.sftp.readlink(hostId, e.path)
          if (target) {
            e.linkTarget = target
            changed = true
          }
        })
      )
    }
    if (changed) {
      const p = pane(hostId)
      if (p.children[dir] === entries) {
        patch(hostId, { children: { ...p.children, [dir]: next } })
      }
    }
  }

  /** 逐级展开到目标（对照 expand(to:)），返回应聚焦路径 */
  const expandTo = async (hostId: string, target: string): Promise<string | null> => {
    const normalized = normalizePath(target)
    const root = pane(hostId).root
    if (normalized === root) {
      patch(hostId, { path: root })
      return null
    }
    if (!isUnderPath(normalized, root)) return null
    const relative =
      root === '/' ? normalized.replace(/^\//, '') : normalized.slice(root.length + 1)
    const parts = relative.split('/').filter(Boolean)
    if (parts.length === 0) return null

    let current = root
    let focus: string | null = null
    for (let i = 0; i < parts.length; i++) {
      await load(hostId, current)
      const next = joinPath(current, parts[i])
      const isLast = i === parts.length - 1
      const entry = (pane(hostId).children[current] ?? []).find((e) => e.name === parts[i])
      if (!entry) {
        if (isLast && (await load(hostId, next)) !== null) {
          focus = next
          patch(hostId, { path: pane(hostId).children[next] ? next : current })
        }
        break
      }
      focus = entry.path
      if (entry.isDir) {
        patch(hostId, {
          expanded: [...new Set([...pane(hostId).expanded, entry.path])]
        })
        current = entry.path
        if (isLast) {
          await load(hostId, entry.path)
          patch(hostId, { path: entry.path })
        }
      } else {
        patch(hostId, { path: current })
        break
      }
    }
    return focus
  }

  /** 跳转并定位（对照 reveal） */
  const reveal = async (hostId: string, target: string): Promise<void> => {
    patch(hostId, { loading: true })
    try {
      const resolved = await window.aterm.sftp.realpath(hostId, target)
      const p = pane(hostId)
      patch(hostId, { path: resolved })
      if (!isUnderPath(resolved, p.root) && p.root !== '/') {
        if ((await load(hostId, '/')) !== null) patch(hostId, { root: '/', banner: null })
      }
      await load(hostId, pane(hostId).root)
      const focus = await expandTo(hostId, resolved)
      patch(hostId, { focusedPath: focus ?? resolved })
    } catch (err) {
      patch(hostId, { banner: errorMessage(err) })
    } finally {
      patch(hostId, { loading: false })
    }
  }

  /** 连接级初始路径：initDir 为空回 home；~ / ~/ 前缀用 home 展开（sftp-server 的 realpath 不认 ~） */
  const revealTarget = (home: string, hostId: string): string => {
    const conn = useConnectionsStore.getState().connections.find((c) => c.id === hostId)
    const dir = conn?.initDir?.trim()
    if (!dir || dir === '~') return home
    if (dir.startsWith('~/')) return normalizePath(joinPath(home, dir.slice(2)))
    return normalizePath(dir)
  }

  /** 首连/重连：开通道 + 定根 + 展开到初始路径（initDir，空则 home） */
  const connectAndList = async (hostId: string): Promise<void> => {
    const api = window.aterm.sftp
    patch(hostId, { status: 'connecting', banner: null, loading: true })
    try {
      await api.start(hostId)
      const home = await api.realpath(hostId, '.')
      patch(hostId, { home, path: home, status: 'connected', error: null })
      if ((await load(hostId, '/')) !== null) {
        patch(hostId, { root: '/', banner: null })
        await expandTo(hostId, revealTarget(home, hostId))
      } else {
        patch(hostId, { root: home, banner: null })
        await load(hostId, home)
      }
    } catch (err) {
      patch(hostId, { status: 'error', error: errorMessage(err), banner: errorMessage(err) })
    } finally {
      patch(hostId, { loading: false })
    }
  }

  return {
    panes: {},

    ensureStarted: (hostId) => {
      if (pane(hostId).started) return
      patch(hostId, { ...EMPTY_PANE, started: true })
      void connectAndList(hostId)
    },

    dropHost: (hostId) => {
      window.aterm.sftp.stop(hostId)
      set((s) => {
        const panes = { ...s.panes }
        delete panes[hostId]
        return { panes }
      })
    },

    reconnect: (hostId) => {
      if (!pane(hostId).started) return
      void connectAndList(hostId)
    },

    refresh: (hostId) => {
      const p = pane(hostId)
      void (async () => {
        for (const dir of new Set([p.root, ...p.expanded])) {
          await load(hostId, dir)
        }
      })()
    },

    goHome: (hostId) => {
      void reveal(hostId, pane(hostId).home)
    },

    go: (hostId, raw) => {
      const trimmed = raw.trim()
      if (trimmed === '') return
      const home = pane(hostId).home
      const target =
        trimmed === '~'
          ? home
          : trimmed.startsWith('~/')
            ? joinPath(home, trimmed.slice(2))
            : trimmed
      void reveal(hostId, target)
    },

    toggleHidden: (hostId) => {
      patch(hostId, { showHidden: !pane(hostId).showHidden })
    },

    toggle: (hostId, entry) => {
      if (!entry.isDir) return
      const p = pane(hostId)
      if (p.expanded.includes(entry.path)) {
        patch(hostId, { expanded: p.expanded.filter((x) => x !== entry.path) })
      } else {
        patch(hostId, {
          expanded: [...p.expanded, entry.path],
          path: entry.path
        })
        if (!p.children[entry.path]) void load(hostId, entry.path)
      }
    },

    /** 折叠全部（仅视图：children 缓存保留，重新展开零网络请求） */
    collapseAll: (hostId) => {
      if (pane(hostId).expanded.length === 0) return
      patch(hostId, { expanded: [] })
    },

    select: (hostId, entry) => {
      patch(hostId, { path: entry.isDir ? entry.path : parentPath(entry.path) })
    },

    mkdir: async (hostId, name, into) => {
      const parent = into ?? pane(hostId).path
      try {
        await window.aterm.sftp.mkdir(hostId, joinPath(parent, name))
        patch(hostId, { expanded: [...new Set([...pane(hostId).expanded, parent])] })
        await load(hostId, parent)
      } catch (err) {
        patch(hostId, { banner: errorMessage(err) })
      }
    },

    touch: async (hostId, name, into) => {
      const parent = into ?? pane(hostId).path
      const remote = joinPath(parent, name)
      try {
        await window.aterm.sftp.touch(hostId, remote)
        patch(hostId, {
          expanded: [...new Set([...pane(hostId).expanded, parent])],
          focusedPath: remote
        })
        await load(hostId, parent)
      } catch (err) {
        patch(hostId, { banner: errorMessage(err) })
      }
    },

    rename: async (hostId, entry, name) => {
      const parent = parentPath(entry.path)
      const dest = joinPath(parent, name)
      try {
        await window.aterm.sftp.rename(hostId, entry.path, dest)
        const p = pane(hostId)
        const children = { ...p.children }
        delete children[entry.path]
        patch(hostId, {
          children,
          expanded: p.expanded.includes(entry.path)
            ? p.expanded.map((x) => (x === entry.path ? dest : x))
            : p.expanded
        })
        await load(hostId, parent)
      } catch (err) {
        patch(hostId, { banner: errorMessage(err) })
      }
    },

    move: async (hostId, entry, destDir) => {
      const dest = joinPath(destDir, entry.name)
      const parent = parentPath(entry.path)
      const src = entry.path
      const wasExpanded = pane(hostId).expanded.includes(src)
      try {
        await window.aterm.sftp.rename(hostId, src, dest)
        // 移除旧子树缓存（对照 pruneTree）
        const p = pane(hostId)
        const children: Record<string, SftpEntry[]> = {}
        for (const [k, v] of Object.entries(p.children)) {
          if (k !== src && !k.startsWith(`${src}/`)) children[k] = v
        }
        const expanded = p.expanded
          .filter((x) => x !== src && !x.startsWith(`${src}/`))
          .concat([destDir])
        if (wasExpanded) expanded.push(dest)
        let focused = p.focusedPath
        if (focused && (focused === src || focused.startsWith(`${src}/`))) {
          focused = focused === src ? dest : dest + focused.slice(src.length)
        }
        patch(hostId, { children, expanded: [...new Set(expanded)], focusedPath: focused })
        await load(hostId, parent)
        await load(hostId, destDir)
        if (wasExpanded) await load(hostId, dest)
        patch(hostId, { focusedPath: dest })
      } catch (err) {
        patch(hostId, { banner: errorMessage(err) })
      }
    },

    chmod: async (hostId, entry, mode) => {
      try {
        await window.aterm.sftp.chmod(hostId, entry.path, mode)
        await load(hostId, parentPath(entry.path))
      } catch (err) {
        patch(hostId, { banner: errorMessage(err) })
      }
    },

    remove: async (hostId, entry) => {
      const parent = parentPath(entry.path)
      try {
        await window.aterm.sftp.remove(hostId, entry)
        const p = pane(hostId)
        const children = { ...p.children }
        delete children[entry.path]
        patch(hostId, {
          children,
          expanded: p.expanded.filter((x) => x !== entry.path),
          path: p.path === entry.path || p.path.startsWith(`${entry.path}/`) ? parent : p.path
        })
        await load(hostId, parent)
      } catch (err) {
        patch(hostId, { banner: errorMessage(err) })
      }
    },

    download: (hostId, entry) => {
      window.aterm.sftp.download(hostId, entry)
    },

    upload: (hostId, localPaths, destDir) => {
      if (localPaths.length === 0) return
      // 不自动展开目标目录（对照 uploadItem：仅已展开的目录才在完成时刷新）
      window.aterm.sftp.upload(hostId, localPaths, destDir)
    },

    setBanner: (hostId, text) => patch(hostId, { banner: text }),

    applyStateEvent: (e) => {
      const p = pane(e.hostId)
      if (!p.started) return
      patch(e.hostId, { status: e.status, error: e.error ?? null })
      // 通道（重）建立 → 恢复目录视图（对照 hostLinkRestored → connectAndList 的刷新段）
      if (e.status === 'connected' && p.status !== 'connected') {
        void (async () => {
          const home = await window.aterm.sftp.realpath(e.hostId, '.')
          patch(e.hostId, { home })
          for (const dir of new Set([p.root, ...p.expanded, p.path])) {
            await load(e.hostId, dir)
          }
        })()
      }
    },

    applyTransferEvent: (e) => {
      const p = pane(e.hostId)
      if (!p.started) return
      const t = e.transfer
      const exists = p.transfers.some((x) => x.id === t.id)
      const transfers = exists
        ? p.transfers.map((x) => (x.id === t.id ? t : x))
        : [
            t,
            ...p.transfers.filter((item) => item.status === 'running' || item.cleanup),
            ...p.transfers.filter((item) => item.status !== 'running' && !item.cleanup).slice(0, 23)
          ]
      patch(e.hostId, { transfers })
      // 上传完成 → 刷新已展开目录（对照 uploadItem 末尾的按需 load）
      if (t.direction === 'up' && t.status === 'done') {
        for (const dir of new Set([p.root, ...p.expanded])) {
          void load(e.hostId, dir)
        }
      }
      if (t.status === 'error' && t.error) {
        patch(e.hostId, { banner: t.error })
      }
    },

    clearFinished: (hostId) => {
      set((s) => {
        const panes = { ...s.panes }
        for (const id of Object.keys(panes)) {
          if (hostId !== undefined && id !== hostId) continue
          const p = panes[id]
          if (p.transfers.length === 0) continue
          panes[id] = {
            ...p,
            transfers: p.transfers.filter((x) => x.status === 'running' || x.cleanup)
          }
        }
        return { panes }
      })
    }
  }
})

/** 过滤 + 排序（对照 filterSort：目录在前、名称不区分大小写；隐藏文件豁免聚焦项） */
export function listedEntries(pane: SftpPaneState, dirPath: string): SftpEntry[] {
  const rows = pane.children[dirPath] ?? []
  const filtered = pane.showHidden
    ? rows
    : rows.filter((e) => !e.name.startsWith('.') || e.path === pane.focusedPath)
  return [...filtered].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans', { sensitivity: 'base' })
  })
}
