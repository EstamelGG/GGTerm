import { ipcMain } from 'electron'
import type { PerfSample } from '../../shared/types'
import { perfRefreshAll, perfSetPaused, perfSnapshotAll, perfWatch } from '../ssh/perfHub'
import { sessionPerfWatch } from '../ssh/sessionPerf'

import { channels } from './channels'

export function registerPerformanceIpc(): void {
  ipcMain.handle(channels.perfSnapshot, (): Record<string, PerfSample> => perfSnapshotAll())

  // 连接列表页可见行集合全量同步（IntersectionObserver 驱动；diff 在 perfHub 内）
  ipcMain.on(channels.perfWatch, (_e, hostIds: string[]) => {
    perfWatch(Array.isArray(hostIds) ? hostIds : [])
  })

  // 性能列表头手动刷新：清熔断 + 立即采样
  ipcMain.on(channels.perfRefresh, () => {
    perfRefreshAll()
  })

  // 性能列隐藏（窄窗口）→ 暂停采样计时器（条目/连接/样本保留），恢复可见续跑
  ipcMain.on(channels.perfSetPaused, (_e, paused: boolean) => {
    perfSetPaused(paused === true)
  })

  // 会话页活动栏面板打开/关闭 → 独立会话采样（借用会话共享连接，与连接列表视口采样解耦）
  ipcMain.on(channels.perfWatchSession, (_e, hostId: unknown) => {
    sessionPerfWatch(typeof hostId === 'string' ? hostId : null)
  })
}
