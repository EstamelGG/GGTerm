/** SDK 的首片超时从收到响应头后开始；补齐连接/响应头阶段的超时。 */
export async function modelFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('Model connection timed out after 120s')),
    120_000
  )
  const original = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  try {
    return await fetch(input, {
      ...init,
      signal: original ? AbortSignal.any([original, controller.signal]) : controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
}
