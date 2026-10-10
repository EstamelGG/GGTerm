import { BrowserWindow, ipcMain } from 'electron'
import { questions } from './questions'
export function registerQuestionIpc(): void {
  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
  questions.on('request', (request) => broadcast('question:request', request))
  questions.on('resolved', (id) => broadcast('question:resolved', id))
  ipcMain.handle('question:list', () => questions.list())
  ipcMain.handle(
    'question:answer',
    (_e, sessionId: string, id: string, index: number | null, text?: string) => {
      if (text !== undefined && typeof text !== 'string') throw new Error('Invalid answer')
      questions.answer(sessionId, id, index, text)
    }
  )
  ipcMain.handle('question:cancel', (_e, sessionId: string, id: string) =>
    questions.cancel(sessionId, id)
  )
}
