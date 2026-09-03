import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Writable } from 'node:stream'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { TransferTask } from '../src/main/ssh/transferTask'
vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  dialog: {},
  shell: { showItemInFolder: vi.fn() }
}))
import { app } from 'electron'
vi.mock('../src/main/log', () => ({ appLog: vi.fn() }))
import { SftpSession } from '../src/main/ssh/sftp'
import type { HostLink, HostLinkEvents } from '../src/main/ssh/link'
import type { SftpEntry, SftpTransferEvent } from '../src/shared/types'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'aterm-test-'))
  vi.mocked(app.getPath).mockReturnValue(root)
})
afterEach(async () => {
  expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
  expect(basename(root)).toMatch(/^aterm-test-/)
  await fs.rm(root, { recursive: true, force: true })
})

function session(onTransfer?: (event: SftpTransferEvent, session: SftpSession) => void): {
  s: SftpSession
  events: SftpTransferEvent[]
  writes: Map<string, Buffer[]>
  channel: { destroy: ReturnType<typeof vi.fn> }
  client: { end: ReturnType<typeof vi.fn> }
} {
  const writes = new Map<string, Buffer[]>()
  const channel = {
    destroy: vi.fn(),
    mkdir: vi.fn((_path, cb) => cb(null)),
    createWriteStream: (path: string) => {
      writes.set(path, [])
      return new Writable({
        write(chunk, _encoding, cb) {
          writes.get(path)!.push(Buffer.from(chunk))
          setTimeout(cb, 2)
        }
      })
    }
  }
  const client = { sftp: (cb) => cb(null, channel), end: vi.fn() }
  const events: SftpTransferEvent[] = []
  const s = new SftpSession(
    { activeClient: client, hostId: 'host' } as unknown as HostLink,
    {
      onSftpState: vi.fn(),
      onSftpMeasure: vi.fn(),
      onSftpTransfer: (event) => {
        events.push(event)
        onTransfer?.(event, s)
      }
    } as Pick<HostLinkEvents, 'onSftpState' | 'onSftpMeasure' | 'onSftpTransfer'>
  )
  return { s, events, channel, client, writes }
}

describe('real transfer cancellation', () => {
  it('downloads complete file contents through the cancellable reader', async () => {
    const fixture = session()
    const content = Buffer.alloc(180000, 123)
    Object.assign(fixture.channel, {
      open: (_path, _flags, cb) => cb(null, Buffer.from('handle')),
      read: (_handle, buffer, offset, length, position, cb) => {
        const bytes = Math.min(length, content.length - position)
        content.copy(buffer, offset, position, position + bytes)
        cb(null, bytes)
      },
      close: (_handle, cb) => cb(null)
    })
    await fixture.s.download({
      name: 'complete.bin',
      path: '/complete.bin',
      size: content.length,
      isDir: false
    } as SftpEntry)
    expect(await fs.readFile(join(root, 'complete.bin'))).toEqual(content)
    expect(fixture.events.at(-1)?.transfer.status).toBe('done')
    expect(fixture.events.at(-1)?.transfer.bytes).toBe(content.length)
  })
  it.each(['open', 'read', 'close'])(
    'finishes cancellation when remote %s never responds',
    async (stalled) => {
      const fixture = session()
      const cancel = (): void => {
        setTimeout(() => fixture.s.cancelTransfer(fixture.events[0].transfer.id), 5)
      }
      Object.assign(fixture.channel, {
        open: (_path, _flags, cb) => {
          if (stalled === 'open') cancel()
          else cb(null, Buffer.from('handle'))
        },
        read: (_handle, _buffer, _offset, _length, _position, cb) => {
          if (stalled === 'read') cancel()
          else cb(null, 0)
        },
        close: (_handle, cb) => {
          if (stalled === 'close') cancel()
          else cb(null)
        }
      })
      await fixture.s.download({
        name: 'stalled.bin',
        path: '/stalled.bin',
        size: 0,
        isDir: false
      } as SftpEntry)
      expect(fixture.events.at(-1)?.transfer.status).toBe('canceled')
      expect(await fs.readdir(root)).toEqual([])
      expect(fixture.channel.destroy).toHaveBeenCalled()
      expect(fixture.client.end).not.toHaveBeenCalled()
    },
    2000
  )
  it('stops writing bytes instead of only changing the progress label', async () => {
    await fs.writeFile(join(root, 'large.bin'), Buffer.alloc(8 * 1024 * 1024, 7))
    const fixture = session((event, s) => {
      if (event.transfer.bytes >= 65536) s.cancelTransfer(event.transfer.id)
    })
    await fixture.s.upload([join(root, 'large.bin')], '/upload')
    expect(fixture.events.at(-1)?.transfer.status).toBe('canceled')
    expect(
      fixture.events.some(
        ({ transfer }) => transfer.status === 'running' && transfer.cancelRequested
      )
    ).toBe(true)
    expect(Buffer.concat(fixture.writes.get('/upload/large.bin') ?? []).length).toBeLessThan(
      8 * 1024 * 1024
    )
    expect(fixture.channel.destroy).toHaveBeenCalled()
    expect(fixture.client.end).not.toHaveBeenCalled()
  })
  it('includes hidden files and hidden subdirectories in an uploaded directory', async () => {
    await fs.writeFile(join(root, '.env'), 'VALUE=secret')
    await fs.mkdir(join(root, '.config'))
    await fs.writeFile(join(root, '.config', 'settings'), 'value')
    const fixture = session()
    await fixture.s.upload([root], '/upload')
    expect([...fixture.writes.keys()]).toEqual(
      expect.arrayContaining([
        `/upload/${basename(root)}/.env`,
        `/upload/${basename(root)}/.config/settings`
      ])
    )
    expect(fixture.events.at(-1)?.transfer.status).toBe('done')
  })
  it('closes a channel even when it opens after cancellation', async () => {
    const task = new TransferTask()
    const close = vi.fn()
    let ready!: (channel: string) => void
    const opening = task.opening(
      new Promise<string>((resolve) => {
        ready = resolve
      }),
      close
    )
    task.cancel()
    await expect(opening).rejects.toThrow(/canceled/)
    ready('late channel')
    await Promise.resolve()
    expect(close).toHaveBeenCalledWith('late channel')
  })
})
