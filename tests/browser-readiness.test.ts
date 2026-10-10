import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import {
  browserDocumentReady,
  trackBrowserDocument,
  waitForBrowserDocument
} from '../src/main/browserReadiness'
function page(): WebContents {
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isLoading: () => true
  }) as unknown as WebContents
  trackBrowserDocument(wc)
  return wc
}
afterEach(() => vi.useRealTimers())
it('document readiness is independent of pending resources and resets only for full navigation', async () => {
  const wc = page()
  const ready = waitForBrowserDocument(wc)
  wc.emit('dom-ready')
  expect(browserDocumentReady(wc)).toBe(false)
  wc.emit('did-navigate')
  wc.emit('dom-ready')
  expect(await ready).toBe(true)
  expect(browserDocumentReady(wc)).toBe(true)
  wc.emit('did-start-navigation', {}, 'https://example.com/#route', true, true)
  expect(browserDocumentReady(wc)).toBe(true)
  wc.emit('did-start-navigation', {}, 'https://example.com/next', false, true)
  expect(browserDocumentReady(wc)).toBe(false)
})
it('bounds slow navigation and cleans listeners after timeout or cancellation', async () => {
  vi.useFakeTimers()
  const wc = page()
  const baseline = wc.listenerCount('dom-ready')
  const waiting = waitForBrowserDocument(wc, undefined, 100)
  await vi.advanceTimersByTimeAsync(100)
  expect(await waiting).toBe(false)
  expect(wc.listenerCount('dom-ready')).toBe(baseline)
  const controller = new AbortController()
  const cancelled = waitForBrowserDocument(wc, controller.signal)
  const rejected = expect(cancelled).rejects.toThrow('cancelled')
  controller.abort()
  await rejected
  expect(wc.listenerCount('dom-ready')).toBe(baseline)
})
it('settles failed navigation without accepting subframe failure as a page error', async () => {
  const wc = page()
  const waiting = waitForBrowserDocument(wc)
  wc.emit('did-fail-load', {}, -2, 'iframe failure', '', false)
  const failed = expect(waiting).rejects.toThrow('main failure')
  wc.emit('did-fail-load', {}, -2, 'main failure', '', true)
  await failed
})
