// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { usePerfStore } from '../src/renderer/src/stores/perf'
import type { PerfSample } from '../src/shared/types'

const sample = (hostId: string): PerfSample =>
  ({ hostId, osName: 'Linux', t: 1, cpuPct: 25, netRx: 2, netTx: 3 }) as PerfSample

afterEach(() => {
  vi.restoreAllMocks()
  usePerfStore.setState({ osNames: {}, samples: {}, histories: {} })
  localStorage.clear()
})
it('keeps live samples and history when cache writes fail', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  expect(() => usePerfStore.getState().apply(sample('host'))).not.toThrow()
  expect(usePerfStore.getState().samples.host.cpuPct).toBe(25)
  expect(usePerfStore.getState().histories.host.cpu).toHaveLength(1)
  expect(usePerfStore.getState().osNames.host).toBe('Linux')
})
it('removes deleted hosts from all caches even without an OS cache entry', () => {
  usePerfStore.getState().apply(sample('keep'))
  usePerfStore.getState().apply({ ...sample('gone'), osName: '' })
  usePerfStore.getState().prune(['keep'])
  expect(Object.keys(usePerfStore.getState().samples)).toEqual(['keep'])
  expect(Object.keys(usePerfStore.getState().histories)).toEqual(['keep'])
  const previous = usePerfStore.getState()
  usePerfStore.getState().prune(['keep'])
  expect(usePerfStore.getState()).toBe(previous)
})
