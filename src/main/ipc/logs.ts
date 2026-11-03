import { ipcMain } from 'electron'
import type { AppLogEntry } from '../../shared/types'
import { appLog, clearLogs, getLogs } from '../log'
import { channels } from './channels'

export function registerLogIpc(): void {
  /** 应用内日志：历史拉取 / 渲染层写入 / 清空 */
  ipcMain.handle(channels.appLogs, (): AppLogEntry[] => getLogs())

  ipcMain.on(
    channels.appLogPush,
    (_e, { category, message }: { category: string; message: string }) => {
      appLog(category, message)
    }
  )

  ipcMain.on(channels.appLogClear, () => clearLogs())
}
