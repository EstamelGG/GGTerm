import { ipcMain } from 'electron'
import type { AppLogEntry } from '../../shared/types'
import { appLog, clearLogs, getLogs } from '../log'
import { channels } from './channels'
import { runOneWay } from './delivery'
import { logSchema, parseInput } from './validation'

export function registerLogIpc(): void {
  /** 应用内日志：历史拉取 / 渲染层写入 / 清空 */
  ipcMain.handle(channels.appLogs, (): AppLogEntry[] => getLogs())

  ipcMain.on(channels.appLogPush, (_e, input: unknown) => {
    runOneWay(channels.appLogPush, () => {
      const { category, message } = parseInput(logSchema, input)
      appLog(category, message)
    })
  })

  ipcMain.on(channels.appLogClear, () => runOneWay(channels.appLogClear, clearLogs))
}
