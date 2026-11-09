import { expect, it, vi } from 'vitest'
import { watchSnapshot } from '../src/renderer/src/lib/watchSnapshot'

it('merges new events and removals over an older snapshot, and ignores callbacks after disposal', async () => {
  let finish!: (items: { id: string; value: number }[]) => void
  let upsert!: (item: { id: string; value: number }) => void
  let remove!: (id: string) => void
  const publish = vi.fn(),
    live = vi.fn(),
    off = vi.fn()
  const stop = watchSnapshot({
    load: () =>
      new Promise<{ id: string; value: number }[]>((resolve) => {
        finish = resolve
      }),
    key: (item) => item.id,
    replace: publish,
    upsert: live,
    remove: vi.fn(),
    listen: (add, drop) => {
      upsert = add
      remove = drop
      return off
    },
    failed: vi.fn(),
    restored: vi.fn()
  })
  upsert({ id: 'new', value: 2 })
  remove('done')
  finish([
    { id: 'done', value: 1 },
    { id: 'new', value: 1 }
  ])
  await Promise.resolve()
  expect(publish).toHaveBeenCalledWith([{ id: 'new', value: 2 }])
  stop()
  upsert({ id: 'late', value: 3 })
  expect(live).toHaveBeenCalledOnce()
  expect(off).toHaveBeenCalledOnce()
})

it('offers retry after failure and never publishes a snapshot after unmount', async () => {
  const failed = vi.fn(),
    replace = vi.fn(),
    restored = vi.fn()
  let reply!: (items: { id: string }[]) => void
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          reply = resolve
        })
    )
  const stop = watchSnapshot<{ id: string }>({
    load,
    key: (x) => x.id,
    replace,
    listen: () => vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
    failed,
    restored
  })
  await Promise.resolve()
  expect(failed).toHaveBeenCalledOnce()
  const retry = failed.mock.calls[0][1]()
  stop()
  reply([{ id: 'old' }])
  await retry
  expect(replace).not.toHaveBeenCalled()
  expect(restored).not.toHaveBeenCalled()
})
