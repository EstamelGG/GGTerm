import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { afterEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ exec: vi.fn(), send: vi.fn(), client: null as Client | null }))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: fixture.send } }] }
}))
vi.mock('../src/main/ssh/sftp', () => ({ execCommand: fixture.exec }))
vi.mock('../src/main/ssh/resourceLink', () => ({
  getResourceLink: () =>
    fixture.client ? { activeClient: fixture.client, connection: { name: 'Host' } } : null
}))
vi.mock('../src/main/data/connections', () => ({ listConnections: () => [{ id: 'host' }] }))
vi.mock('../src/main/log', () => ({ appLog: vi.fn() }))
import { sessionGpuWatch } from '../src/main/ssh/gpuPerf'

afterEach(() => {
  sessionGpuWatch(null)
  fixture.client = null
  vi.clearAllMocks()
  vi.useRealTimers()
})

it('rejects samples from an old panel even when the same host is reopened', async () => {
  vi.useFakeTimers()
  let oldReply!: (out: string) => void
  let newReply!: (out: string) => void
  fixture.exec
    .mockImplementationOnce(
      () =>
        new Promise<string>((r) => {
          oldReply = r
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise<string>((r) => {
          newReply = r
        })
    )
  fixture.client = new EventEmitter() as Client
  sessionGpuWatch('host')
  const signal = fixture.exec.mock.calls[0][3] as AbortSignal
  sessionGpuWatch(null)
  sessionGpuWatch('host')
  expect(signal.aborted).toBe(true)
  oldReply('')
  await vi.advanceTimersByTimeAsync(15000)
  expect(fixture.send).not.toHaveBeenCalled()
  expect(fixture.exec).toHaveBeenCalledTimes(2)
  newReply('')
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.send).toHaveBeenCalledExactlyOnceWith(
    'perf:gpu',
    expect.objectContaining({
      resource: expect.objectContaining({ hostId: 'host', kind: 'gpu' })
    })
  )
})

it('starts sampling when a watched host becomes connected later', async () => {
  vi.useFakeTimers()
  fixture.exec.mockResolvedValue('')
  sessionGpuWatch('host')
  expect(fixture.exec).not.toHaveBeenCalled()
  fixture.client = new EventEmitter() as Client
  await vi.advanceTimersByTimeAsync(15000)
  expect(fixture.send).toHaveBeenCalledOnce()
})
