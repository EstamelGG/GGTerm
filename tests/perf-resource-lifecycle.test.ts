import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { afterEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('../src/main/ssh/sftp', () => ({ execCommand: fixture.exec }))
vi.mock('../src/main/log', () => ({ appLog: vi.fn() }))
import { PerfMonitor } from '../src/main/ssh/perf'
const output = 'P 100 50 200 100 1024 512 100 20 2 0 0 1000 2000 0 0 0 1 20 100'
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('does not start exec after being stopped while acquiring a client', async () => {
  vi.useFakeTimers()
  const pending = deferred<Client>()
  const monitor = new PerfMonitor('host', () => pending.promise, vi.fn())
  monitor.refreshNow()
  monitor.stop()
  pending.resolve(new EventEmitter() as Client)
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.exec).not.toHaveBeenCalled()
})

it('discards late samples and keeps a replacement request locked until it finishes', async () => {
  vi.useFakeTimers()
  const old = deferred<string>(),
    fresh = deferred<string>()
  fixture.exec.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  let client = new EventEmitter() as Client
  const receive = vi.fn()
  const monitor = new PerfMonitor('host', () => client, receive)
  monitor.refreshNow()
  await vi.advanceTimersByTimeAsync(0)
  const oldSignal = fixture.exec.mock.calls[0][3] as AbortSignal
  monitor.stop()
  expect(oldSignal.aborted).toBe(true)
  client = new EventEmitter() as Client
  monitor.refreshNow()
  await vi.advanceTimersByTimeAsync(0)
  old.resolve(output)
  await vi.advanceTimersByTimeAsync(0)
  expect(receive).not.toHaveBeenCalled()
  monitor.refreshNow()
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.exec).toHaveBeenCalledTimes(2)
  fresh.resolve(output)
  await vi.advanceTimersByTimeAsync(0)
  expect(receive).toHaveBeenCalledOnce()
  expect(receive.mock.calls[0][0].resource).toMatchObject({ hostId: 'host', kind: 'perf' })
  monitor.stop()
})

it('drops a sample whose selected connection changed, even before a close event', async () => {
  vi.useFakeTimers()
  const pending = deferred<string>()
  fixture.exec.mockReturnValueOnce(pending.promise)
  let client = new EventEmitter() as Client
  const receive = vi.fn()
  const monitor = new PerfMonitor('host', () => client, receive, '', {
    isClientCurrent: (candidate) => candidate === client
  })
  monitor.refreshNow()
  await vi.advanceTimersByTimeAsync(0)
  client = new EventEmitter() as Client
  pending.resolve(output)
  await vi.advanceTimersByTimeAsync(0)
  expect(receive).not.toHaveBeenCalled()
  monitor.stop()
})

it('resets rate baselines when switching to a different SSH transport', async () => {
  vi.useFakeTimers()
  fixture.exec.mockResolvedValue(output)
  let client = new EventEmitter() as Client
  const receive = vi.fn()
  const monitor = new PerfMonitor('host', () => client, receive)
  monitor.refreshNow()
  await vi.advanceTimersByTimeAsync(1000)
  monitor.refreshNow()
  await vi.advanceTimersByTimeAsync(0)
  expect(receive.mock.calls[1][0].netRx).toBe(0)
  client = new EventEmitter() as Client
  await vi.advanceTimersByTimeAsync(1000)
  monitor.refreshNow()
  await vi.advanceTimersByTimeAsync(0)
  expect(receive.mock.calls[2][0].netRx).toBeNull()
  expect(receive.mock.calls[2][0].resource.connectionId).not.toBe(
    receive.mock.calls[0][0].resource.connectionId
  )
  monitor.stop()
})
