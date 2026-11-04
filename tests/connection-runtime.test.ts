import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostConnection } from '../src/shared/types'
import type { HostLinkEvents } from '../src/main/ssh/link'

const fixture = vi.hoisted(() => ({
  clients: [] as (EventEmitter & { end: ReturnType<typeof vi.fn> })[],
  hosts: [] as HostConnection[]
}))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/main/data/secrets', () => ({ loadSecrets: () => ({ password: 'test' }) }))
vi.mock('../src/main/data/connections', () => ({ listConnections: () => fixture.hosts }))
vi.mock('../src/main/ssh/hostKeys', () => ({
  createHostVerifier: () => ({ verify: () => true, error: () => null })
}))
vi.mock('../src/main/log', () => ({ appLog: vi.fn() }))
vi.mock('../src/main/i18n', () => ({ t: (key: string) => key }))
vi.mock('../src/main/ssh/sftp', () => ({
  SftpSession: class {
    stop = vi.fn()
    hostLinkRestored = vi.fn()
    hostLinkLost = vi.fn()
  },
  execCommand: vi.fn()
}))
vi.mock('ssh2', () => ({
  Client: class extends EventEmitter {
    constructor() {
      super()
      fixture.clients.push(this)
    }
    connect = vi.fn()
    setNoDelay = vi.fn()
    end = vi.fn(() => {
      this.emit('close')
    })
    forwardOut(
      _src: string,
      _srcPort: number,
      _host: string,
      _port: number,
      cb: (error: null, channel: { close: () => void }) => void
    ): void {
      cb(null, { close: vi.fn() })
    }
  }
}))
const { HostLink } = await import('../src/main/ssh/link')
const host = {
  id: 'host',
  host: 'fixture.test',
  name: 'Fixture',
  port: 22,
  username: 'test',
  authType: 'password',
  connectTimeout: 500,
  keepaliveInterval: 5000
} as HostConnection
const links: InstanceType<typeof HostLink>[] = []
function create(patch: Partial<HostConnection> = {}): InstanceType<typeof HostLink> {
  const events: HostLinkEvents = {
    onHostState: vi.fn(),
    onShellState: vi.fn(),
    onShellData: vi.fn(),
    onShellAnnounce: vi.fn(),
    onSftpState: vi.fn(),
    onSftpTransfer: vi.fn(),
    onSftpMeasure: vi.fn()
  }
  const link = new HostLink(host.id, { ...host, ...patch }, events, { probeOs: false })
  links.push(link)
  return link
}
beforeEach(() => {
  fixture.clients = []
  fixture.hosts = []
  vi.useFakeTimers()
})
afterEach(() => {
  links.splice(0).forEach((link) => link.shutdown())
  vi.useRealTimers()
})

it('cancels a pending handshake on close without retrying or publishing a late failure', async () => {
  const link = create()
  link.start()
  link.shutdown()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(fixture.clients).toHaveLength(1)
  expect(fixture.clients[0].end).toHaveBeenCalledOnce()
  expect(link.phase).toBe('idle')
  expect(link.events.onHostState).toHaveBeenLastCalledWith(
    expect.objectContaining({ phase: 'idle' })
  )
  await expect(link.waitForActive()).rejects.toThrow('closed')
  expect(() => link.start()).toThrow('closed')
})
it('cannot let a late handshake failure overwrite a successful replacement attempt', async () => {
  const link = create()
  link.start()
  const fail = fixture.clients[0].listeners('error')[0]
  link.restart()
  fixture.clients[1].emit('ready')
  fail(new Error('late failure'))
  await vi.advanceTimersByTimeAsync(0)
  expect(link.phase).toBe('connected')
  expect(link.activeClient).toBe(fixture.clients[1])
  expect(link.offlineReason).toBe('')
})
it('closes all intermediate jump clients when canceled while dialing the target', async () => {
  fixture.hosts = [{ ...host, id: 'jump' }]
  const link = create({ jumpHostIds: ['jump'] })
  link.start()
  fixture.clients[0].emit('ready')
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.clients).toHaveLength(2)
  link.shutdown()
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.clients.every((client) => client.end.mock.calls.length === 1)).toBe(true)
  expect(link.effectiveJumpIds).toEqual(['jump'])
})
it('cancels retry waits and disposes borrowed resources exactly once', async () => {
  const link = create()
  const dispose = vi.fn()
  link.ownTransportResource(dispose)
  link.start()
  fixture.clients[0].emit('error', new Error('unreachable'))
  await vi.advanceTimersByTimeAsync(0)
  link.shutdown()
  link.shutdown()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(fixture.clients).toHaveLength(1)
  expect(dispose).toHaveBeenCalledOnce()
})

it('stops retrying rejected credentials and lets manual login request fresh credentials', async () => {
  const link = create({ authType: 'manual' })
  link.update(link.connection, { password: 'wrong' })
  link.start()
  fixture.clients[0].emit(
    'error',
    Object.assign(new Error('Bad credentials'), { level: 'client-authentication' })
  )
  await vi.advanceTimersByTimeAsync(10_000)
  expect(fixture.clients).toHaveLength(1)
  expect(link.phase).toBe('offline')
  expect(link.awaitingCredentials).toBe(true)
  expect(link.offlineReason).toBe('Bad credentials')
})

it('cancels backoff without losing shells and permits a clean manual retry', async () => {
  const link = create()
  const shell = link.addShell()
  link.start()
  fixture.clients[0].emit('error', new Error('unreachable'))
  await vi.advanceTimersByTimeAsync(0)
  expect(link.phase).toBe('reconnecting')
  link.cancelConnect()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(fixture.clients).toHaveLength(1)
  expect(link.phase).toBe('idle')
  expect(link.shells.get(shell.id)).toBe(shell)
  link.start()
  expect(fixture.clients).toHaveLength(2)
  expect(link.offlineReason).toBe('')
  link.cancelConnect()
})

it('reopens the existing terminal after transport loss and announces recovery once', async () => {
  const link = create()
  const shell = link.addShell()
  const readyShell = (client: EventEmitter): void => {
    Object.assign(client, {
      shell: (_options: unknown, cb: (error: null, channel: EventEmitter) => void) =>
        cb(null, Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: vi.fn() }))
    })
    client.emit('ready')
  }
  link.start()
  readyShell(fixture.clients[0])
  await vi.advanceTimersByTimeAsync(0)
  expect(shell.status).toBe('connected')
  fixture.clients[0].emit('close')
  expect(link.phase).toBe('reconnecting')
  readyShell(fixture.clients[1])
  await vi.advanceTimersByTimeAsync(0)
  expect(shell.status).toBe('connected')
  expect(link.offlineReason).toBe('')
  expect(link.events.onShellAnnounce).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'announce.reconnected' })
  )
  // Cancel is deliberately a no-op once a connection has recovered.
  link.cancelConnect()
  expect(link.phase).toBe('connected')
})
