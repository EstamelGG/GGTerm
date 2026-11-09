import { ipcMain } from 'electron'
import type { AiUIMessage } from '../../shared/types'
import * as ai from '../ai/engine'
import { getApiKey, setApiKey } from '../data/aiSecrets'
import { channels } from './channels'
import {
  parseInput,
  sessionSchema,
  runSchema,
  cancelSchema,
  modelSchema,
  idSchema,
  keySchema
} from './validation'

export function registerAiIpc(): void {
  ipcMain.handle(channels.aiListSessions, () => ai.listSessions())
  ipcMain.handle(channels.aiCreateSession, () => ai.createSession())
  ipcMain.handle(channels.aiGetMessages, (_e, input: unknown) =>
    ai.getMessages(parseInput(sessionSchema, input).sessionId)
  )
  ipcMain.handle(channels.aiCloseSession, (_e, input: unknown) =>
    ai.closeSession(parseInput(sessionSchema, input).sessionId)
  )
  ipcMain.handle(channels.aiRun, (_e, input: unknown) => {
    const { sessionId, messages, turnId } = parseInput(runSchema, input)
    return ai.run(sessionId, messages as AiUIMessage[], turnId)
  })
  ipcMain.handle(channels.aiCancel, (_e, input: unknown) => {
    const { sessionId, turnId } = parseInput(cancelSchema, input)
    return ai.cancel(sessionId, turnId)
  })
  ipcMain.handle(channels.aiListModels, (_e, input: unknown) =>
    ai.listModels(parseInput(modelSchema, input).providerId)
  )
  ipcMain.handle(channels.aiHasApiKey, (_e, input: unknown) =>
    Boolean(getApiKey(parseInput(idSchema, input)))
  )
  ipcMain.handle(channels.aiSetApiKey, (_e, input: unknown) => {
    const { profileId, apiKey } = parseInput(keySchema, input)
    setApiKey(profileId, apiKey)
  })
}
