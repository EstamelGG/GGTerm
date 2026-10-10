import type { WebContents } from 'electron'
const documents = new WeakMap<WebContents, { ready: boolean; committed: boolean; error?: string }>()
/** Resource loading and document readiness are separate: slow images must not block the page. */
export function trackBrowserDocument(wc: WebContents): void {
  const state = { ready: false, committed: false } as {
    ready: boolean
    committed: boolean
    error?: string
  }
  documents.set(wc, state)
  wc.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) {
      state.committed = false
      state.ready = false
      state.error = undefined
    }
  })
  wc.on('did-navigate', () => {
    state.committed = true
  })
  wc.on('dom-ready', () => {
    if (!state.committed || state.error) return
    state.ready = true
    state.error = undefined
  })
  wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3) state.error = description
  })
}
export function invalidateBrowserDocument(wc: WebContents): void {
  const state = documents.get(wc)
  if (state) {
    state.committed = false
    state.ready = false
    state.error = undefined
  }
}
export function browserDocumentReady(wc: WebContents): boolean {
  return documents.get(wc)?.ready ?? !wc.isLoading()
}
export async function waitForBrowserDocument(
  wc: WebContents,
  signal?: AbortSignal,
  timeoutMs = 15000
): Promise<boolean> {
  signal?.throwIfAborted()
  if (wc.isDestroyed()) throw new Error('Browser tab closed')
  if (browserDocumentReady(wc)) return true
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, ready = false): void => {
      clearTimeout(timer)
      wc.removeListener('dom-ready', readyListener)
      wc.removeListener('did-fail-load', failed)
      wc.removeListener('destroyed', closed)
      signal?.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve(ready)
    }
    const readyListener = (): void => {
      if (browserDocumentReady(wc)) finish(undefined, true)
    }
    const closed = (): void => finish(new Error('Browser tab closed'))
    const aborted = (): void => finish(new Error('Browser operation cancelled'))
    const failed = (
      _event: unknown,
      code: number,
      description: string,
      _url: string,
      mainFrame: boolean
    ): void => {
      if (mainFrame) finish(code === -3 ? undefined : new Error(description))
    }
    const timer = setTimeout(() => finish(), timeoutMs)
    wc.on('dom-ready', readyListener)
    wc.on('did-fail-load', failed)
    wc.once('destroyed', closed)
    signal?.addEventListener('abort', aborted, { once: true })
    const error = documents.get(wc)?.error
    if (error) finish(new Error(error))
  })
}
export async function requireBrowserDocument(wc: WebContents, signal?: AbortSignal): Promise<void> {
  if (!(await waitForBrowserDocument(wc, signal)))
    throw new Error('Page document is still loading; retry snapshot or read when ready')
}
