import { beforeEach, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => unknown
const state = vi.hoisted(() => ({
  invoke: new Map<string, Handler>(),
  send: new Map<string, Handler>(),
  windows: [] as Array<{
    isDestroyed: () => boolean
    webContents: { send: ReturnType<typeof vi.fn> }
  }>,
  notifier: vi.fn(),
  getPreferences: vi.fn(),
  setPreferences: vi.fn(),
  rescan: vi.fn(),
  resolveLocale: vi.fn(),
  setLocale: vi.fn(),
  menu: vi.fn(),
  logs: vi.fn(),
  log: vi.fn(),
  clearLogs: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  getMessages: vi.fn(),
  closeSession: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  listModels: vi.fn(),
  getKey: vi.fn(),
  setKey: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: Handler) => {
      if (state.invoke.has(name)) throw new Error(`Duplicate handler: ${name}`)
      state.invoke.set(name, handler)
    },
    on: (name: string, handler: Handler) => {
      if (state.send.has(name)) throw new Error(`Duplicate listener: ${name}`)
      state.send.set(name, handler)
    }
  },
  BrowserWindow: { getAllWindows: () => state.windows }
}))
vi.mock('../src/main/data/prefs', () => ({
  getPreferences: state.getPreferences,
  setPreferences: state.setPreferences,
  setPrefsNotifier: state.notifier
}))
vi.mock('../src/main/ssh/perfHub', () => ({ perfRescan: state.rescan }))
vi.mock('../src/main/i18n', () => ({
  resolveLocale: state.resolveLocale,
  setLocalePref: state.setLocale
}))
vi.mock('../src/main/menu', () => ({ installMenu: state.menu }))
vi.mock('../src/main/log', () => ({
  getLogs: state.logs,
  appLog: state.log,
  clearLogs: state.clearLogs
}))
vi.mock('../src/main/ai/engine', () => ({
  listSessions: state.listSessions,
  createSession: state.createSession,
  getMessages: state.getMessages,
  closeSession: state.closeSession,
  run: state.run,
  cancel: state.cancel,
  listModels: state.listModels
}))
vi.mock('../src/main/data/aiSecrets', () => ({ getApiKey: state.getKey, setApiKey: state.setKey }))
// Exercise the real entry point with the other, unchanged domains isolated.
vi.mock('../src/main/ipc/connections', () => ({ registerConnectionIpc: vi.fn() }))
vi.mock('../src/main/ipc/workspace', () => ({ registerWorkspaceIpc: vi.fn() }))
vi.mock('../src/main/ipc/performance', () => ({ registerPerformanceIpc: vi.fn() }))
vi.mock('../src/main/ai/executionIpc', () => ({ registerExecutionIpc: vi.fn() }))
vi.mock('../src/main/ai/humanInputIpc', () => ({ registerHumanInputIpc: vi.fn() }))
vi.mock('../src/main/ai/questionIpc', () => ({ registerQuestionIpc: vi.fn() }))
import { registerIpc } from '../src/main/ipc'

beforeEach(() => {
  vi.resetAllMocks()
  state.invoke.clear()
  state.send.clear()
  state.windows = []
  registerIpc()
})

it('returns saved preferences and applies scale and sampling changes only when requested', () => {
  const saved = { uiScale: 123, perfMonitorDisabled: true }
  state.getPreferences.mockReturnValue(saved)
  state.setPreferences.mockReturnValue(saved)
  const setZoomFactor = vi.fn()
  const event = { sender: { setZoomFactor } }
  expect(state.invoke.get('prefs:get')!()).toBe(saved)
  const patch = { uiScale: 123, perfMonitorDisabled: true }
  expect(state.invoke.get('prefs:set')!(event, patch)).toBe(saved)
  expect(state.setPreferences).toHaveBeenCalledWith(patch)
  expect(setZoomFactor).toHaveBeenCalledWith(1.25)
  expect(state.rescan).toHaveBeenCalledOnce()
  state.invoke.get('prefs:set')!(event, { accentHex: '#37A563' })
  expect(setZoomFactor).toHaveBeenCalledOnce()
  expect(state.rescan).toHaveBeenCalledOnce()
})

it('broadcasts main-process preference updates to all surviving windows', () => {
  const live = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  const closed = { isDestroyed: () => true, webContents: { send: vi.fn() } }
  state.windows = [live, closed]
  const saved = { uiScale: 100 }
  state.notifier.mock.calls[0][0](saved)
  expect(live.webContents.send).toHaveBeenCalledWith('prefs:changed', saved)
  expect(closed.webContents.send).not.toHaveBeenCalled()
})

it('preserves the immediate locale reply and broadcasts after language and menu updates', async () => {
  state.getPreferences.mockReturnValue({ locale: 'auto' })
  state.resolveLocale.mockReturnValue('en')
  expect(state.invoke.get('locale:get')!()).toEqual({ pref: 'auto', locale: 'en' })
  let finish!: (locale: string) => void
  state.setLocale.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve
      })
  )
  const send = vi.fn(() => expect(state.menu).toHaveBeenCalledOnce())
  state.windows = [{ isDestroyed: () => false, webContents: { send } }]
  expect(state.invoke.get('locale:set')!({}, 'zh-CN')).toEqual({ pref: 'zh-CN', locale: 'en' })
  expect(state.setLocale).toHaveBeenCalledWith('zh-CN')
  expect(state.menu).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  finish('zh-CN')
  await Promise.resolve()
  expect(send).toHaveBeenCalledWith('locale:changed', { locale: 'zh-CN' })
})

it('keeps log history as a request and log writes and clears as events', () => {
  const entries = [{ category: 'sftp', message: 'Ready' }]
  state.logs.mockReturnValue(entries)
  expect(state.invoke.get('app:logs')!()).toBe(entries)
  state.send.get('app:log-push')!({}, entries[0])
  expect(state.log).toHaveBeenCalledWith('sftp', 'Ready')
  state.send.get('app:log-clear')!()
  expect(state.clearLogs).toHaveBeenCalledOnce()
  expect(state.invoke.has('app:log-push')).toBe(false)
})

it('retains AI session replies and the one-way close event', () => {
  const sessions = [{ id: 'session' }],
    messages = [{ id: 'message' }]
  state.listSessions.mockReturnValue(sessions)
  state.createSession.mockReturnValue(sessions[0])
  state.getMessages.mockReturnValue(messages)
  expect(state.invoke.get('ai:listSessions')!()).toBe(sessions)
  expect(state.invoke.get('ai:createSession')!()).toBe(sessions[0])
  expect(state.invoke.get('ai:getMessages')!({}, { sessionId: 'session' })).toBe(messages)
  expect(state.getMessages).toHaveBeenCalledWith('session')
  expect(state.send.get('ai:closeSession')!({}, { sessionId: 'session' })).toBeUndefined()
  expect(state.closeSession).toHaveBeenCalledWith('session')
  expect(state.invoke.has('ai:closeSession')).toBe(false)
})

it('preserves AI run errors and cancellation session and turn identity', async () => {
  const failure = new Error('Provider unavailable')
  state.run.mockRejectedValue(failure)
  const messages = [{ id: 'message' }]
  await expect(
    state.invoke.get('ai:run')!({}, { sessionId: 'session', messages, turnId: 'turn' })
  ).rejects.toBe(failure)
  expect(state.run).toHaveBeenCalledWith('session', messages, 'turn')
  state.cancel.mockResolvedValue(messages)
  await expect(
    state.invoke.get('ai:cancel')!({}, { sessionId: 'session', turnId: 'turn' })
  ).resolves.toBe(messages)
  expect(state.cancel).toHaveBeenLastCalledWith('session', 'turn')
  await state.invoke.get('ai:cancel')!({}, { sessionId: 'session' })
  expect(state.cancel).toHaveBeenLastCalledWith('session', undefined)
})

it('returns model lists and only exposes key presence through the legacy profile argument', async () => {
  const models = ['model']
  state.listModels.mockResolvedValue(models)
  await expect(state.invoke.get('ai:listModels')!({}, { providerId: 'provider' })).resolves.toBe(
    models
  )
  expect(state.listModels).toHaveBeenCalledWith('provider')
  state.getKey.mockReturnValue('test-key')
  expect(state.invoke.get('ai:hasApiKey')!({}, 'provider')).toBe(true)
  expect(state.getKey).toHaveBeenCalledWith('provider')
  state.getKey.mockReturnValue('')
  expect(state.invoke.get('ai:hasApiKey')!({}, 'provider')).toBe(false)
  state.invoke.get('ai:setApiKey')!({}, { profileId: 'provider', apiKey: 'test-key' })
  expect(state.setKey).toHaveBeenCalledWith('provider', 'test-key')
})
