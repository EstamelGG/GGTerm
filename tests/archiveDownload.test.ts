import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }))
import { utilityProcess } from 'electron'
import { receiveArchive, extractArchive } from '../src/main/ssh/archiveDownload'
import { TransferTask } from '../src/main/ssh/transferTask'
let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'aterm-archive-test-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

it('stops local writing even when remote destroy never calls back', async () => {
  const task = new TransferTask()
  const remote = new Readable({
    read() {
      /* Deliberately stalled remote input. */
    },
    destroy() {
      /* unresponsive SSH close */
    }
  })
  const path = join(root, 'partial.tar')
  const receive = receiveArchive(remote, path, task, () => task.cancel())
  remote.push(Buffer.alloc(65536))
  await expect(receive).rejects.toThrow()
  expect(remote.destroyed).toBe(true)
  await fs.rm(path)
}, 2000)

it('writes a complete archive without destroying the remote before exit status', async () => {
  const task = new TransferTask()
  const remote = new Readable({
    read() {
      /* Data is pushed by the test. */
    },
    autoDestroy: false
  })
  const path = join(root, 'complete.tar')
  const receiving = receiveArchive(remote, path, task, () => {})
  remote.push(Buffer.from('archive bytes'))
  remote.push(null)
  await receiving
  expect(await fs.readFile(path, 'utf8')).toBe('archive bytes')
  expect(remote.destroyed).toBe(false)
})

it('kills extraction and waits for process exit before allowing cleanup', async () => {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) })
  vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as Electron.UtilityProcess)
  const task = new TransferTask()
  const extracting = extractArchive('archive', root, task)
  const settled = vi.fn()
  const result = extracting.catch(settled)
  task.cancel()
  expect(child.kill).toHaveBeenCalledOnce()
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  child.emit('exit', 1)
  await result
  expect(settled).toHaveBeenCalledOnce()
})
