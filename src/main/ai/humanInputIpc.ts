import { BrowserWindow, ipcMain } from 'electron'
import { executions } from './exec'
import type { HumanInputRequest, HumanInputResolved } from '../../shared/execution'

/**
 * 人工输入（密码 / 验证码等敏感提示）通道。
 *
 * 与只读的 execution:* 查看器 API 严格分开：查看器永不暴露 stdin / PTY resize，
 * 模型也没有任何写敏感输入的入口（execute input 会被拒）。
 * 只有用户在会话「需要输入」卡片上显式提交的值，才经本通道直接写入该执行会话的 PTY：
 * 不经模型、不进输出缓冲（回显抹除）、不进日志、不落盘。
 */

const REQUEST = 'human-input:request'
const RESOLVED = 'human-input:resolved'
const LIST = 'human-input:list'
const SUBMIT = 'human-input:submit'
const CANCEL = 'human-input:cancel'

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

export function registerHumanInputIpc(): void {
  executions.onHumanInputRequest((request: HumanInputRequest) => broadcast(REQUEST, request))
  executions.onHumanInputResolved((info: HumanInputResolved) => broadcast(RESOLVED, info))

  // 渲染层启动/刷新后恢复未收尾的卡片（执行仍挂在主进程上）
  ipcMain.handle(LIST, (_event, sessionId?: string) =>
    executions.pendingHumanInput(typeof sessionId === 'string' && sessionId ? sessionId : undefined)
  )
  ipcMain.handle(SUBMIT, (_event, sessionId: string, id: string, value: string) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('AI session id is required')
    if (typeof id !== 'string' || !id) throw new Error('Execution id is required')
    if (typeof value !== 'string' || value.trim() === '') throw new Error('Input value is required')
    executions.submitHumanInput(sessionId, id, value)
  })
  ipcMain.handle(CANCEL, (_event, sessionId: string, id: string) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('AI session id is required')
    if (typeof id !== 'string' || !id) throw new Error('Execution id is required')
    executions.cancelHumanInput(sessionId, id)
  })
}
