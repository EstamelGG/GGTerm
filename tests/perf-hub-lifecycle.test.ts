import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  clients: [] as Array<EventEmitter & { end: ReturnType<typeof vi.fn> }>,
  factories: [] as Array<() => Promise<unknown>>,
  activeClient: null as unknown
}))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/main/log', () => ({ appLog: vi.fn() }))
vi.mock('../src/main/data/connections', () => ({
  listConnections: () => [
    {
      id: 'host',
      name: 'Host',
      host: 'example.test',
      port: 22,
      username: 'user',
      authType: 'password',
      connectTimeout: 5000
    }
  ]
}))
vi.mock('../src/main/data/secrets', () => ({ loadSecrets: () => ({ password: 'test' }) }))
vi.mock('../src/main/data/prefs', () => ({
  getPreferences: () => ({ perfMonitorDisabled: false })
}))
vi.mock('../src/main/ssh/hostKeys', () => ({
  createHostVerifier: () => ({ verify: () => true, error: () => null })
}))
vi.mock('../src/main/ssh/resourceLink', () => ({
  getResourceLink: () => ({ activeClient: state.activeClient })
}))
vi.mock('ssh2', () => ({
  Client: class extends EventEmitter {
    end = vi.fn()
    connect(): void {
      state.clients.push(this)
    }
    setNoDelay(): void {
      /* no socket in this fixture */
    }
  }
}))
vi.mock('../src/main/ssh/perf', () => ({
  HUB_INTERVAL_MS: 10000,
  PerfMonitor: class {
    constructor(_id: string, factory: () => Promise<unknown>) {
      state.factories.push(factory)
    }
    start(): void {
      /* sampling is driven explicitly by each test */
    }
    stop(): void {
      /* no timer in this fixture */
    }
    noteFailure(): void {
      /* no backoff in this fixture */
    }
  }
}))
const { perfWatch, perfInvalidate, perfForget } = await import('../src/main/ssh/perfHub')
beforeEach(() => {
  state.clients.length = 0
  state.factories.length = 0
  state.activeClient = null
})
afterEach(() => {
  perfWatch([])
  perfForget('host')
})

it('closes a probe that finishes after its watcher was removed', async () => {
  perfWatch(['host'])
  const pending = state.factories[0]()
  perfWatch([])
  state.clients[0].emit('ready')
  expect(await pending).toBeNull()
  expect(state.clients[0].end).toHaveBeenCalledTimes(1)
})

it('does not let an obsolete authentication failure block a replacement watcher', async () => {
  perfWatch(['host'])
  const pending = state.factories[0]()
  perfInvalidate('host')
  state.clients[0].emit('error', new Error('authentication failed'))
  await pending
  const replacement = state.factories[1]()
  expect(state.clients).toHaveLength(2)
  state.clients[1].emit('ready')
  expect(await replacement).toBe(state.clients[1])
})

it('releases a redundant probe when a shared connection becomes available during dialing', async () => {
  perfWatch(['host'])
  const pending = state.factories[0]()
  state.activeClient = {}
  state.clients[0].emit('ready')
  expect(await pending).toBe(state.activeClient)
  expect(state.clients[0].end).toHaveBeenCalledTimes(1)
})
