import { ipcMain } from 'electron'
import type { AiUIMessage } from '../../shared/types'
import * as ai from '../ai/engine'
import { getApiKey, setApiKey } from '../data/aiSecrets'
import { channels } from './channels'

export function registerAiIpc(): void {
  /* ---------------- AI Agent（⑤） ---------------- */

  ipcMain.handle(channels.aiListSessions, () => ai.listSessions())

  ipcMain.handle(channels.aiCreateSession, () => ai.createSession())

  ipcMain.handle(channels.aiGetMessages, (_e, { sessionId }: { sessionId: string }) =>
    ai.getMessages(sessionId)
  )

  ipcMain.on(channels.aiCloseSession, (_e, { sessionId }: { sessionId: string }) => {
    void ai.closeSession(sessionId)
  })

  ipcMain.handle(
    channels.aiRun,
    (
      _e,
      {
        sessionId,
        messages,
        turnId
      }: { sessionId: string; messages: AiUIMessage[]; turnId: string }
    ) => ai.run(sessionId, messages, turnId)
  )

  ipcMain.handle(
    channels.aiCancel,
    (_e, { sessionId, turnId }: { sessionId: string; turnId?: string }) =>
      ai.cancel(sessionId, turnId)
  )

  ipcMain.handle(channels.aiListModels, (_e, { providerId }: { providerId: string }) =>
    ai.listModels(providerId)
  )

  ipcMain.handle(channels.aiHasApiKey, (_e, profileId: string) => Boolean(getApiKey(profileId)))

  ipcMain.handle(
    channels.aiSetApiKey,
    (_e, { profileId, apiKey }: { profileId: string; apiKey: string }) => {
      setApiKey(profileId, apiKey)
    }
  )
}
