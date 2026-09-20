import { afterEach, expect, it, vi } from 'vitest'
import { modelFetch } from '../src/main/ai/modelFetch'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('响应头超时会中止 fetch；收到响应头后不再计时，不干扰长流', async () => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason))
        })
    )
  )
  const pending = modelFetch('https://example.test')
  const rejected = expect(pending).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(120_000)
  await rejected
  let signal!: AbortSignal
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init) => {
      signal = init.signal
      return new Response('ok')
    })
  )
  await modelFetch('https://example.test')
  await vi.advanceTimersByTimeAsync(120_000)
  expect(signal.aborted).toBe(false)
})
