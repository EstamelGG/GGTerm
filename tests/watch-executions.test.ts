import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { watchExecutions } from '../src/renderer/src/lib/watchExecutions'
import type { ExecutionSnapshot } from '../src/shared/execution'
let ids: string[], change: (id: string) => void, sessions: () => void
const load = vi.fn(),
  apply = vi.fn(),
  failed = vi.fn(),
  recovered = vi.fn(),
  off = vi.fn()
const watch = (): (() => void) =>
  watchExecutions({
    ids: () => ids,
    load,
    apply,
    failed,
    recovered,
    onChanged: (cb) => {
      change = cb
      return off
    },
    onSessionsChanged: (cb) => {
      sessions = cb
      return off
    }
  })
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  ids = ['s']
  load.mockResolvedValue([])
})
afterEach(() => vi.useRealTimers())
it('uses one initial query and periodic reconciliation instead of per-second polling', async () => {
  const stop = watch()
  await vi.advanceTimersByTimeAsync(14000)
  expect(load).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1000)
  expect(load).toHaveBeenCalledTimes(2)
  change('s')
  change('s')
  await vi.advanceTimersByTimeAsync(1)
  expect(load).toHaveBeenCalledTimes(3)
  stop()
  expect(vi.getTimerCount()).toBe(0)
  expect(off).toHaveBeenCalledTimes(2)
})
it('backs off failed queries, preserves known data and supports an immediate retry', async () => {
  load.mockRejectedValue(new Error('IPC unavailable'))
  const stop = watch()
  await vi.advanceTimersByTimeAsync(3000)
  expect(load).toHaveBeenCalledTimes(3)
  expect(apply).not.toHaveBeenCalled()
  expect(failed).toHaveBeenCalledTimes(3)
  load.mockResolvedValue([])
  failed.mock.calls.at(-1)![2]()
  await vi.advanceTimersByTimeAsync(1)
  expect(load).toHaveBeenCalledTimes(4)
  expect(recovered).toHaveBeenCalledWith('s')
  stop()
})
it('ignores an in-flight snapshot invalidated by a lifecycle event and refetches once', async () => {
  let resolve!: (value: ExecutionSnapshot[]) => void
  load.mockImplementationOnce(
    () =>
      new Promise<ExecutionSnapshot[]>((done) => {
        resolve = done
      })
  )
  const stop = watch()
  await vi.advanceTimersByTimeAsync(0)
  change('s')
  change('s')
  resolve([{ status: 'running' } as ExecutionSnapshot])
  await vi.advanceTimersByTimeAsync(1)
  expect(load).toHaveBeenCalledTimes(2)
  expect(apply).toHaveBeenCalledExactlyOnceWith([])
  stop()
})
it('ignores closed sessions and late replies after disposal', async () => {
  let resolve!: (value: ExecutionSnapshot[]) => void
  load.mockImplementation(
    () =>
      new Promise<ExecutionSnapshot[]>((done) => {
        resolve = done
      })
  )
  const stop = watch()
  await vi.advanceTimersByTimeAsync(0)
  ids = ['pending:new']
  sessions()
  resolve([])
  await vi.advanceTimersByTimeAsync(1)
  expect(apply).not.toHaveBeenCalled()
  expect(load).toHaveBeenCalledTimes(1)
  stop()
  change('s')
  expect(vi.getTimerCount()).toBe(0)
})
