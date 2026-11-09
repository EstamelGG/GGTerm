import { expect, it, vi } from 'vitest'
import { DirectoryMeasure } from '../src/main/ssh/directoryMeasure'
import type { SftpEntry } from '../src/shared/types'
vi.mock('../src/main/log', () => ({ appLog: vi.fn() }))
const file = (path: string, size: number): SftpEntry => ({ path, size, isDir: false }) as SftpEntry
const dir = (path: string): SftpEntry => ({ path, size: 0, isDir: true }) as SftpEntry

it('reports unreadable children while retaining successfully measured data', async () => {
  const emit = vi.fn()
  const measure = new DirectoryMeasure(
    'host',
    async (path) => {
      if (path === '/root') return [file('/root/a', 7), dir('/root/denied'), dir('/root/open')]
      if (path === '/root/denied') throw new Error('Permission denied')
      return [file('/root/open/b', 5)]
    },
    emit
  )
  await measure.measure('/root')
  expect(emit).toHaveBeenLastCalledWith(
    expect.objectContaining({
      hostId: 'host',
      path: '/root',
      bytes: 12,
      files: 2,
      dirs: 2,
      skipped: 1,
      skippedPaths: ['denied'],
      done: true
    })
  )
})

it('does not emit canceled results or enqueue children after a replacement measurement', async () => {
  let finish!: (entries: SftpEntry[]) => void
  const list = vi.fn((path: string) =>
    path === '/old'
      ? new Promise<SftpEntry[]>((resolve) => {
          finish = resolve
        })
      : Promise.resolve([file('/new/a', 3)])
  )
  const emit = vi.fn()
  const measure = new DirectoryMeasure('host', list, emit)
  const old = measure.measure('/old')
  await measure.measure('/new')
  finish([dir('/old/child')])
  await old
  expect(list.mock.calls.map(([path]) => path)).toEqual(['/old', '/new'])
  expect(emit.mock.calls.every(([event]) => event.path === '/new')).toBe(true)
  expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ done: true, bytes: 3 }))
})

it('reports root read failure as a completed measurement error', async () => {
  const emit = vi.fn()
  await new DirectoryMeasure(
    'host',
    async () => {
      throw new Error('Offline')
    },
    emit
  ).measure('/root')
  expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ done: true, error: 'Offline' }))
})
