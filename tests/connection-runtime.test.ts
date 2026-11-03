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
