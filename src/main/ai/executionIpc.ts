import { ipcMain } from 'electron'
import { executions } from './exec'

/** Viewer API deliberately exposes no stdin or PTY resize operations. */
export function registerExecutionIpc(): void {
  ipcMain.handle('execution:list', (_event, sessionId: string, hostId?: string) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('AI session id is required')
    return executions.list(sessionId, typeof hostId === 'string' && hostId ? hostId : undefined)
  })
  ipcMain.handle('execution:read', (_event, sessionId: string, id: string, cursor: number) =>
    executions.snapshot(sessionId, id, cursor, true)
  )
  ipcMain.handle('execution:terminate', (_event, sessionId: string, id: string) => {
    executions.close(sessionId, id)
  })
}
