import { create } from 'zustand'
import type { AppLogEntry } from '@shared/types'

/**
 * 应用内运行日志（渲染层镜像）：主进程 'app:log' 实时追加，
 * 打开面板时经 'app:logs' 拉取历史；上限与主进程缓冲一致（500）。
 */
interface LogState {
  entries: AppLogEntry[]
  open: boolean
  /** 折叠为底部单行（不遮挡画面）；菜单再次呼出时自动展开 */
  collapsed: boolean
  filter: string | null
  append: (e: AppLogEntry) => void
  replaceAll: (list: AppLogEntry[]) => void
  setOpen: (v: boolean) => void
  setCollapsed: (v: boolean) => void
  setFilter: (c: string | null) => void
  clear: () => void
}

export const useLogStore = create<LogState>((set) => ({
  entries: [],
  open: false,
  collapsed: false,
  filter: null,

  append: (e) =>
    set((s) => ({
      entries: s.entries.length >= 500 ? [...s.entries.slice(1), e] : [...s.entries, e]
    })),
  replaceAll: (list) => set({ entries: list.slice(-500) }),
  setOpen: (v) => set({ open: v }),
  setCollapsed: (v) => set({ collapsed: v }),
  setFilter: (c) => set({ filter: c }),
  clear: () => set({ entries: [] })
}))
