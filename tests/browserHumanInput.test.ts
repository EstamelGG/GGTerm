import { afterEach, expect, test, vi } from 'vitest'
import { BrowserHumanInputManager } from '../src/main/ai/browserHumanInput'

afterEach(() => vi.useRealTimers())
const context = {
  sessionId: 'session',
  tabId: 'tab',
  url: 'https://example.test/login',
  prompt: 'Password'
}
test('secret goes only to the fill callback, not events or the model result', async () => {
  const manager = new BrowserHumanInputManager()
  const events: unknown[] = []
  manager.on('request', (request) => events.push(request))
  manager.on('resolved', (result) => events.push(result))
  const fill = vi.fn(async () => {})
  const result = manager.ask(context, fill)
  const request = manager.list()[0]
  await expect(manager.submit('other', request.executionId, 'private-value')).rejects.toThrow(
    'conversation'
  )
  await manager.submit('session', request.executionId, 'private-value')
  expect(fill).toHaveBeenCalledWith('private-value')
  expect(await result).toEqual({ humanInputOutcome: 'submitted' })
  expect(JSON.stringify(events)).not.toContain('private-value')
  expect(manager.list()).toEqual([])
})
test('cancel and timeout remove requests without filling', async () => {
  vi.useFakeTimers()
  const manager = new BrowserHumanInputManager()
  const fill = vi.fn(async () => {})
  const cancelled = manager.ask(context, fill)
  manager.cancel('session', manager.list()[0].executionId)
  expect(await cancelled).toEqual({ humanInputOutcome: 'cancelled' })
  const expired = manager.ask(context, fill)
  await vi.advanceTimersByTimeAsync(300000)
  expect(await expired).toEqual({ humanInputOutcome: 'expired' })
  expect(fill).not.toHaveBeenCalled()
})
test('abort and failed filling cannot leave pending cards or expose error secrets', async () => {
  const manager = new BrowserHumanInputManager()
  const controller = new AbortController()
  const cancelled = manager.ask(context, async () => {}, controller.signal)
  controller.abort()
  expect(await cancelled).toEqual({ humanInputOutcome: 'cancelled' })
  const failed = manager.ask(context, async () => {
    throw new Error('private-value')
  })
  await expect(
    manager.submit('session', manager.list()[0].executionId, 'private-value')
  ).rejects.toThrow('Page or input changed')
  expect(await failed).toEqual({ humanInputOutcome: 'expired' })
  expect(manager.list()).toEqual([])
})
