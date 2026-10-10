import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Client, SFTPWrapper } from 'ssh2'
import type { HostLink } from '../src/main/ssh/link'

vi.mock('electron', () => ({
  app: {},
  dialog: {},
  shell: {},
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../src/main/localAccess', () => ({ localAccessDeniedError: vi.fn() }))
import { SftpSession } from '../src/main/ssh/sftp'

type TestChannel = EventEmitter & {
  readdir: ReturnType<typeof vi.fn>
  realpath: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}
function channel(stalled = false): TestChannel {
  const ch = new EventEmitter() as EventEmitter & {
    readdir: ReturnType<typeof vi.fn>
    realpath: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }
  ch.readdir = vi.fn((_path, cb) => {
    if (!stalled) cb(null, [])
  })
  ch.realpath = vi.fn((path, cb) => cb(null, path))
  ch.destroy = vi.fn(() => ch.emit('close'))
  return ch
}
function setup(ch = channel()): {
  ch: TestChannel
  client: { sftp: ReturnType<typeof vi.fn> }
  link: HostLink
  session: SftpSession
} {
  const client = { sftp: vi.fn((cb) => cb(null, ch)) }
  const link = { hostId: 'agent-host', activeClient: client } as unknown as HostLink
  const session = new SftpSession(link, {
    onSftpState: vi.fn(),
    onSftpTransfer: vi.fn(),
    onSftpMeasure: vi.fn()
  })
  return { ch, client, link, session }
}
afterEach(() => vi.useRealTimers())

describe('Agent SFTP reconnect lifecycle without opening the file panel', () => {
  it('rejects an in-flight listing on link loss and opens a fresh channel on retry', async () => {
    const { session, link, ch } = setup(channel(true))
    const pending = session.list('/download')
    const failed = expect(pending).rejects.toThrow('connection lost')
    await vi.waitFor(() => expect(ch.readdir).toHaveBeenCalled())
    session.hostLinkLost()
    await failed
    const fresh = channel()
    Object.assign(link, { activeClient: { sftp: vi.fn((cb) => cb(null, fresh)) } })
    await expect(session.list('/download')).resolves.toEqual({ resolved: '/download', entries: [] })
    expect(fresh.readdir).toHaveBeenCalledOnce()
    session.stop()
  })

  it('discards a late channel-open callback without clearing the new connection', async () => {
    const { session, link, client } = setup()
    let callback: (err: Error | null, ch: unknown) => void = () => {}
    client.sftp.mockImplementation((cb) => {
      callback = cb
    })
    const pending = session.list('/old')
    const failed = expect(pending).rejects.toThrow('connection lost')
    session.hostLinkLost()
    const fresh = channel()
    const newClient = { sftp: vi.fn((cb) => cb(null, fresh)) }
    Object.assign(link, { activeClient: newClient as unknown as Client })
    await expect(session.list('/new')).resolves.toMatchObject({ resolved: '/new' })
    await failed
    const stale = channel()
    callback(null, stale as unknown as SFTPWrapper)
    expect(stale.destroy).toHaveBeenCalledOnce()
    await session.list('/still-new')
    expect(newClient.sftp).toHaveBeenCalledOnce()
    session.stop()
  })

  it('reopens an independently closed SFTP channel while SSH stays active', async () => {
    const { session, ch, client } = setup()
    await session.list('/first')
    ch.emit('close')
    const fresh = channel()
    client.sftp.mockImplementation((cb) => cb(null, fresh))
    await session.list('/second')
    expect(fresh.readdir).toHaveBeenCalledOnce()
    session.stop()
  })

  it('times out silent requests and permits subsequent calls to reopen the channel', async () => {
    vi.useFakeTimers()
    const { session, ch, client } = setup(channel(true))
    const pending = session.list('/stalled')
    const failed = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(30000)
    await failed
    expect(ch.destroy).toHaveBeenCalledOnce()
    const fresh = channel()
    client.sftp.mockImplementation((cb) => cb(null, fresh))
    await expect(session.list('/retry')).resolves.toMatchObject({ resolved: '/retry' })
    session.stop()
  })
})
