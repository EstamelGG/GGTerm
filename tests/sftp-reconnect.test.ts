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
import { execCommand, SftpSession } from '../src/main/ssh/sftp'
import { invalidateTransport } from '../src/main/ssh/resourceLifetime'

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

it('rejects operations on an already invalidated transport without opening SFTP', async () => {
  const { client, session } = setup()
  invalidateTransport(client as unknown as Client)
  await expect(session.list('/')).rejects.toThrow(/connection lost/)
  expect(client.sftp).not.toHaveBeenCalled()
  session.stop()
})

it('does not issue requests against a channel invalidated between await continuations', async () => {
  const { session, ch } = setup()
  await session.start()
  const pending = session.list('/')
  session.stop()
  await expect(pending).rejects.toThrow(/connection lost/)
  expect(ch.readdir).not.toHaveBeenCalled()
})

it('rejects an interrupted atomic save and never continues it on a replacement channel', async () => {
  const { session, ch } = setup()
  let reply!: (error: null, attrs: object) => void
  const stat = vi.fn((_path, cb) => {
    reply = cb
  })
  const open = vi.fn()
  Object.assign(ch, { stat, open })
  await session.start()
  const save = session.writeText('/file', 'content')
  const rejected = expect(save).rejects.toThrow(/connection lost/)
  await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce())
  session.stop()
  await rejected
  reply(null, { uid: 1, gid: 1, mode: 0o644 })
  await Promise.resolve()
  expect(open).not.toHaveBeenCalled()
})

it('cancels pending exec immediately and closes its late channel without accepting output', async () => {
  let reply!: (error: null, channel: unknown) => void
  const client = {
    exec: vi.fn((_cmd, cb) => {
      reply = cb
    })
  } as unknown as Client
  const abort = new AbortController()
  const pending = execCommand(client, 'sample', 1024, abort.signal)
  const rejected = expect(pending).rejects.toThrow(/invalidated/)
  abort.abort()
  await rejected
  const stream = Object.assign(new EventEmitter(), { close: vi.fn(), stderr: new EventEmitter() })
  reply(null, stream)
  expect(stream.close).toHaveBeenCalledOnce()
  expect(() => stream.emit('error', new Error('late channel failure'))).not.toThrow()
})

describe('Agent SFTP reconnect lifecycle without opening the file panel', () => {
  it('does not reopen a stopped viewer when its connection becomes ready later', async () => {
    const { session, link, client } = setup()
    let ready!: () => void
    Object.assign(link, {
      activeClient: null,
      waitForActive: () =>
        new Promise<void>((resolve) => {
          ready = resolve
        })
    })
    const pending = session.start()
    session.stop()
    Object.assign(link, { activeClient: client })
    ready()
    await pending
    expect(client.sftp).not.toHaveBeenCalled()
    await session.start()
    expect(client.sftp).toHaveBeenCalledOnce()
    session.stop()
  })

  it('treats connection closure during a canceled start as cancellation', async () => {
    const { session, link } = setup()
    let fail!: (error: Error) => void
    Object.assign(link, {
      activeClient: null,
      waitForActive: () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject
        })
    })
    const pending = session.start()
    session.stop()
    fail(new Error('Connection has been closed'))
    await expect(pending).resolves.toBeUndefined()
  })

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
