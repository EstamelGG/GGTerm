import { isNetworkDevice } from '../../shared/device'
import { listConnections } from '../data/connections'
import { BrowserWindow } from 'electron'
import type { PerfSample } from '../../shared/types'
import { sessionGpuWatch } from './gpuPerf'
import { getLink } from './link'
import { PerfMonitor, SESSION_INTERVAL_MS } from './perf'

/**
 * 会话性能采样（独立于连接列表 perfHub 的视口驱动采样）：
 * 由会话页活动栏面板打开/关闭驱动，借用会话共享连接 exec（零额外连接、零后台探测连接），
 * 与 perfHub 分离 —— 连接列表失焦时 watch([]) 不会覆盖会话的采样条目。
 * GPU 不在这条 3s 全量采样里（见 gpuPerf.ts：独立低频、单独事件流）。
 */

const monitors = new Map<string, PerfMonitor>()

function broadcast(sample: PerfSample): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('perf:sample', sample)
}

/** 面板开 → watch(hostId)；面板关/切走 → watch(null)。一次只保留当前 host 的监控 */
export function sessionPerfWatch(hostId: string | null): void {
  if (hostId && isNetworkDevice(listConnections().find((c) => c.id === hostId))) hostId = null
  sessionGpuWatch(hostId)
  for (const [id, m] of monitors) {
    if (id !== hostId) {
      m.stop()
      monitors.delete(id)
    }
  }
  if (!hostId) return
  if (monitors.has(hostId)) return
  const link = getLink(hostId)
  if (!link) return
  const monitor = new PerfMonitor(
    hostId,
    () => link.activeClient,
    broadcast,
    link.connection.name,
    {
      intervalMs: SESSION_INTERVAL_MS,
      collectNet: true,
      shouldSample: () => !isNetworkDevice(listConnections().find((c) => c.id === hostId))
    }
  )
  monitors.set(hostId, monitor)
  monitor.start()
}
