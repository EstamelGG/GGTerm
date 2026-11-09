import { registerExecutionIpc } from './ai/executionIpc'
import { registerHumanInputIpc } from './ai/humanInputIpc'
import { registerQuestionIpc } from './ai/questionIpc'

import { registerConnectionIpc } from './ipc/connections'
import { registerPerformanceIpc } from './ipc/performance'
import { registerWorkspaceIpc } from './ipc/workspace'
import { registerPreferencesIpc } from './ipc/preferences'
import { registerLocaleIpc } from './ipc/locale'
import { registerLogIpc } from './ipc/logs'
import { registerAiIpc } from './ipc/ai'
export { channels } from './ipc/channels'

/** Application registration entry point; domain modules keep their existing wire contracts. */
export function registerIpc(): void {
  registerConnectionIpc()
  registerWorkspaceIpc()
  registerPerformanceIpc()
  registerExecutionIpc()
  // 人工输入（敏感提示）通道：与只读查看器 API 分开，密码只经此写入 PTY
  registerHumanInputIpc()
  registerQuestionIpc()
  registerPreferencesIpc()
  registerLocaleIpc()
  registerLogIpc()
  registerAiIpc()
}
