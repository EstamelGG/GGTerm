import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/main/data/secrets', () => ({}))
vi.mock('../src/main/data/connections', () => ({ listConnections: () => [] }))
vi.mock('../src/main/ssh/hostKeys', () => ({}))
vi.mock('../src/main/log', () => ({ appLog: vi.fn() }))
vi.mock('../src/main/i18n', () => ({ t: (key: string) => key }))
vi.mock('../src/main/ssh/sftp', () => ({ SftpSession: class {}, execCommand: vi.fn() }))
import { ShellSession, type HostLink } from '../src/main/ssh/link'

function channel(): ClientChannel & { writes: string[] } {
  const ch = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    writes: [] as string[],
    close: vi.fn(),
    write: vi.fn()
  })
  ch.write.mockImplementation((data: string) => {
    ch.writes.push(data)
  })
  return ch as unknown as ClientChannel & { writes: string[] }
}
function setup(): {
  shell: ShellSession
  callbacks: ((error: Error | null, channel: ClientChannel) => void)[]
  events: {
    onShellData: ReturnType<typeof vi.fn>
    onShellState: ReturnType<typeof vi.fn>
    onShellAnnounce: ReturnType<typeof vi.fn>
  }
} {
  vi.useFakeTimers()
  const callbacks: ((error: Error | null, channel: ClientChannel) => void)[] = []
  const client = Object.assign(new EventEmitter(), {
    shell: vi.fn((_opts, cb) => callbacks.push(cb))
  })
  const events = { onShellData: vi.fn(), onShellState: vi.fn(), onShellAnnounce: vi.fn() }
  const link = {
    hostId: 'host',
    activeClient: client,
    isActive: true,
    connection: { connectTimeout: 5000 },
    events
  } as unknown as HostLink
  const shell = new ShellSession(link)
  return { shell, callbacks, events }
}
afterEach(() => vi.useRealTimers())

it('closes channels arriving after an open timeout without publishing connected', async () => {
  const { shell, callbacks, events } = setup()
  shell.start()
  await vi.advanceTimersByTimeAsync(5000)
  const ch = channel()
  callbacks[0](null, ch)
  expect(ch.close).toHaveBeenCalledOnce()
  expect(shell.status).toBe('error')
  expect(events.onShellState.mock.calls.map(([e]) => e.status)).not.toContain('connected')
  shell.close()
})

it('cannot send queued input or old output into a replacement shell', async () => {
  const { shell, callbacks, events } = setup()
  shell.start()
  const old = channel()
  callbacks[0](null, old)
  shell.write('first')
  shell.write('old queued command')
  await vi.advanceTimersByTimeAsync(0)
  expect(old.writes).toEqual(['first'])
  shell.hostLinkLost()
  shell.start()
  const fresh = channel()
  callbacks[1](null, fresh)
  old.emit('data', Buffer.from('stale'))
  old.emit('close')
  fresh.emit('data', Buffer.from('fresh'))
  await vi.advanceTimersByTimeAsync(2001)
  expect(old.close).toHaveBeenCalledOnce()
  expect(fresh.writes).toEqual([])
  expect(events.onShellData).toHaveBeenCalledOnce()
  expect(events.onShellData.mock.calls[0][0]).toMatchObject({
    data: 'fresh',
    resource: { hostId: 'host', kind: 'shell', resourceId: shell.id }
  })
  expect(shell.status).toBe('connected')
  shell.close()
})
