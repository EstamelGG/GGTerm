import { BrowserWindow } from 'electron'
import type { AppLogEntry, AppLogLevel } from '../shared/types'

/**
 * 应用内运行日志：主进程环形缓冲（MAX 条），新条目实时推送到所有窗口
 * （'app:log'），历史经 'app:logs' 拉取。替代散落各处的 console.log。
 */

const MAX = 500
const buffer: AppLogEntry[] = []

export function appLog(category: string, message: string, level: AppLogLevel = 'info'): void {
  const entry: AppLogEntry = { t: Date.now(), category, message, level }
  buffer.push(entry)
  if (buffer.length > MAX) buffer.shift()
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('app:log', entry)
}

export function getLogs(): AppLogEntry[] {
  return buffer.slice()
}

export function clearLogs(): void {
  buffer.length = 0
}
