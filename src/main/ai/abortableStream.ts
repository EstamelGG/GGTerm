/** 即使供应商流没有及时响应 abort，也让 UI 流确定收尾；不等待远端取消确认。 */
export function abortableStream<T>(
  source: ReadableStream<T>,
  signal: AbortSignal,
  abortPart: T
): ReadableStream<T> {
  const reader = source.getReader()
  let ended = false
  let abort: () => void
  return new ReadableStream<T>({
    start(controller) {
      abort = () => {
        if (ended) return
        ended = true
        signal.removeEventListener('abort', abort)
        controller.enqueue(abortPart)
        controller.close()
        void reader.cancel().catch(() => {})
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    },
    async pull(controller) {
      if (ended) return
      try {
        const result = await reader.read()
        if (ended) return
        if (result.done) {
          ended = true
          signal.removeEventListener('abort', abort)
          controller.close()
        } else controller.enqueue(result.value)
      } catch (err) {
        if (ended) return
        ended = true
        signal.removeEventListener('abort', abort)
        controller.error(err)
      }
    },
    cancel() {
      ended = true
      signal.removeEventListener('abort', abort)
      void reader.cancel().catch(() => {})
    }
  })
}
