// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { observeSettledResize } from '../src/renderer/src/lib/observeSettledResize'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('coalesces resize events and cancels pending work on disposal', () => {
  vi.useFakeTimers()
  let resize!: () => void
  const disconnect = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe = vi.fn()
      disconnect = disconnect
    }
  )
  const commit = vi.fn()
  const stop = observeSettledResize(document.createElement('div'), commit)
  for (let i = 0; i < 20; i++) {
    resize()
    vi.advanceTimersByTime(16)
  }
  expect(commit).not.toHaveBeenCalled()
  vi.advanceTimersByTime(150)
  expect(commit).toHaveBeenCalledTimes(1)
  resize()
  stop()
  vi.advanceTimersByTime(200)
  expect(commit).toHaveBeenCalledTimes(1)
  expect(disconnect).toHaveBeenCalledOnce()
})
