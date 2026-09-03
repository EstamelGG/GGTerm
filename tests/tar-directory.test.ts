import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { c, x } from 'tar'
vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  utilityProcess: { fork: vi.fn() }
}))
vi.mock('../src/main/log', () => ({ appLog: vi.fn() }))
import { app, utilityProcess } from 'electron'
import { SftpSession } from '../src/main/ssh/sftp'
import type { HostLink, HostLinkEvents } from '../src/main/ssh/link'
import type { SftpEntry, SftpTransferEvent } from '../src/shared/types'
let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'aterm-tar-test-'))
  vi.mocked(app.getPath).mockReturnValue(root)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

it.each(['success', 'receiving', 'extracting', 'remote-error', 'exit-wait', 'cleanup-failure'])(
  'tar directory download: %s',
  async (mode) => {
    const source = join(root, 'source')
    await fs.mkdir(source)
    await fs.writeFile(join(source, '中文.txt'), 'complete contents')
    const archive = join(root, 'fixture.tar')
    await c({ cwd: source, file: archive }, ['中文.txt'])
    const data = await fs.readFile(archive)
    const events: SftpTransferEvent[] = []
    const end = vi.fn()
    const cancel = (): void => session.cancelTransfer(events[0].transfer.id)
    const client = {
      end,
      exec: (command, cb) => {
        const stream = Object.assign(new PassThrough({ autoDestroy: false }), {
          stderr: new PassThrough(),
          signal: vi.fn()
        })
        cb(null, stream)
        setTimeout(() => {
          if (command.startsWith('tar cf')) {
            if (mode === 'receiving' || mode === 'cleanup-failure') {
              stream.write(data.subarray(0, 1024))
              cancel()
              return
            }
            stream.once('end', () => {
              if (mode === 'exit-wait') {
                setTimeout(cancel, 5)
                return
              }
              stream.emit('close', mode === 'remote-error' ? 2 : 0)
            })
            stream.end(data)
          } else {
            stream.end(command.startsWith('command') ? '/bin/tar' : '100')
            stream.emit('close', 0)
          }
        }, 5)
      }
    }
    vi.mocked(utilityProcess.fork).mockImplementation((_file, args) => {
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(() => {
          setTimeout(() => child.emit('exit', 1), 5)
          return true
        })
      })
      if (mode === 'extracting') setTimeout(cancel, 5)
      else void x({ file: args![0], cwd: args![1] }).then(() => child.emit('exit', 0))
      return child as unknown as Electron.UtilityProcess
    })
    const session = new SftpSession(
      { activeClient: client, hostId: 'host' } as unknown as HostLink,
      {
        onSftpTransfer: (event) => events.push(event),
        onSftpState: vi.fn(),
        onSftpMeasure: vi.fn()
      } as Pick<HostLinkEvents, 'onSftpState' | 'onSftpTransfer' | 'onSftpMeasure'>
    )
    const failingCleanup =
      mode === 'cleanup-failure'
        ? vi.spyOn(fs, 'rm').mockRejectedValue(new Error('file locked'))
        : undefined
    await session.download({ name: 'result', path: '/remote', isDir: true, size: 0 } as SftpEntry)
    expect(events.at(-1)?.transfer.status).toBe(
      mode === 'success' ? 'done' : mode === 'remote-error' ? 'error' : 'canceled'
    )
    if (failingCleanup) {
      expect(events.at(-1)?.transfer.cleanup).toBe('error')
      expect(events.at(-1)?.transfer.cleanupError).toContain('file locked')
      failingCleanup.mockRestore()
      await session.retryCleanup(events[0].transfer.id)
    }
    expect(events.at(-1)?.transfer.cleanup).toBeUndefined()
    expect((await fs.readdir(root)).some((name) => name.startsWith('.ggterm-'))).toBe(false)
    if (mode === 'success')
      expect(await fs.readFile(join(root, 'result', '中文.txt'), 'utf8')).toBe('complete contents')
    else await expect(fs.stat(join(root, 'result'))).rejects.toThrow()
    expect(end).not.toHaveBeenCalled()
  },
  3000
)
