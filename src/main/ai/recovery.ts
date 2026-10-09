import { wrapLanguageModel, type LanguageModel } from 'ai'
import { randomUUID } from 'node:crypto'
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4,
  LanguageModelV4StreamPart
} from '@ai-sdk/provider'
import type { AiRecoveryState } from '../../shared/types'

export interface RecoveryOptions {
  signal: AbortSignal
  timeout?: { firstChunkMs: number; chunkMs: number }
  delays?: number[]
  onRecovery?: (state: AiRecoveryState | undefined) => void
  onDiscardSample?: (id: string) => void
  repairContext?: (params: LanguageModelV4CallOptions) => Promise<LanguageModelV4CallOptions>
}

function details(error: unknown): Record<string, unknown> {
  return error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
}

export function isContextOverflow(error: unknown): boolean {
  const e = details(error)
  const text = `${e.message ?? error} ${e.responseBody ?? ''}`
  return /context[_ -]length[_ -]exceeded|maximum context length|context window|too many (input )?tokens|prompt (is )?too long|input.*exceeds.*token|上下文.*(超|满)/i.test(
    text
  )
}

export function recoveryReason(error: unknown): AiRecoveryState['reason'] | undefined {
  const e = details(error)
  const text = `${e.message ?? error} ${e.responseBody ?? ''}`
  if (
    isContextOverflow(error) ||
    /insufficient_quota|billing|credit balance|payment required/i.test(text)
  )
    return undefined
  const status = Number(e.statusCode ?? e.status)
  if (status === 429) return 'rate-limit'
  if (status === 408 || status === 504 || e.name === 'TimeoutError') return 'timeout'
  if (status >= 500 && status <= 599) return 'server'
  if (status >= 400 && status < 500) return undefined
  if (e.isRetryable === true) return 'network'
  if (
    /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|network|fetch failed|socket|disconnected|terminated|premature|stream.*(closed|ended)|connection.*(lost|closed)|timeout|timed out/i.test(
      `${text} ${e.code ?? ''}`
    )
  )
    return 'network'
  if (e.cause && e.cause !== error) return recoveryReason(e.cause)
  return undefined
}

export async function waitForRecovery(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Race even providers that ignore cancellation; always remove our listeners/timers. */
async function timed<T>(
  operation: PromiseLike<T>,
  ms: number,
  signal: AbortSignal,
  timeout: () => void
): Promise<T> {
  signal.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            const error = new Error('Model response timed out')
            error.name = 'TimeoutError'
            reject(error)
            timeout()
          },
          Math.max(1, ms)
        )
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
      })
    ])
  } finally {
    clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
  }
}

/**
 * Retry only a model sampling request. SDK stream retries keep completed steps and
 * discard failed-attempt model output. Tools are withheld until the provider's
 * finish marker, including on exhausted retries, so failed samples cannot execute.
 */
export function recoveringModel(model: LanguageModel, options: RecoveryOptions): LanguageModelV4 {
  if (typeof model === 'string') throw new Error('Recovery requires a configured provider model')
  const delays = options.delays ?? [2_000, 4_000, 8_000, 16_000, 30_000]
  const limits = options.timeout ?? { firstChunkMs: 120_000, chunkMs: 90_000 }
  let key = ''
  let attempts = 0
  let repairs = 0
  let repaired: LanguageModelV4CallOptions | undefined

  const retry = async (error: unknown): Promise<boolean> => {
    options.signal.throwIfAborted()
    const reason = recoveryReason(error)
    if (!reason || attempts >= delays.length) return false
    const e = details(error)
    const headers = details(e.responseHeaders)
    const header = headers['retry-after']
    const seconds = Number(header)
    const retryAfter = Number.isFinite(seconds)
      ? seconds * 1000
      : typeof header === 'string'
        ? Date.parse(header) - Date.now()
        : 0
    const delay = Math.min(60_000, Math.max(delays[attempts], retryAfter || 0))
    attempts++
    options.onRecovery?.({
      attempt: attempts,
      maxAttempts: delays.length,
      retryAt: Date.now() + delay,
      reason
    })
    await waitForRecovery(delay, options.signal)
    return true
  }

  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      wrapGenerate: async ({ params, model }) => {
        let count = 0
        // Summary requests have an independent bounded retry budget.
        while (true) {
          const controller = new AbortController()
          const signal = AbortSignal.any([options.signal, controller.signal])
          try {
            const result = await timed(
              model.doGenerate({ ...params, abortSignal: signal }),
              limits.firstChunkMs,
              options.signal,
              () => controller.abort()
            )
            options.onRecovery?.(undefined)
            return result
          } catch (error) {
            options.signal.throwIfAborted()
            const reason = recoveryReason(error)
            if (!reason || count >= delays.length) throw error
            const delay = delays[count++]
            options.onRecovery?.({
              attempt: count,
              maxAttempts: delays.length,
              retryAt: Date.now() + delay,
              reason
            })
            await waitForRecovery(delay, options.signal)
          }
        }
      },
      wrapStream: async ({ params, model }) => {
        const nextKey = JSON.stringify(params.prompt)
        if (nextKey !== key) {
          key = nextKey
          attempts = 0
          repairs = 0
          repaired = undefined
        }
        let current = repaired ?? params
        while (true) {
          const controller = new AbortController()
          const signal = AbortSignal.any([options.signal, controller.signal])
          let reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart> | undefined
          const sampleId = randomUUID()
          try {
            const deadline = Date.now() + limits.firstChunkMs
            const result = await timed(
              model.doStream({ ...current, abortSignal: signal }),
              limits.firstChunkMs,
              options.signal,
              () => controller.abort()
            )
            reader = result.stream.getReader()
            let nextDeadline = deadline
            let finished = false
            const buffered: LanguageModelV4StreamPart[] = []
            const stream = new ReadableStream<LanguageModelV4StreamPart>({
              async pull(ctrl) {
                try {
                  while (true) {
                    const { done, value } = await timed(
                      reader!.read(),
                      nextDeadline - Date.now(),
                      options.signal,
                      () => controller.abort()
                    )
                    if (done) {
                      if (!finished) throw new Error('Provider stream ended before completion')
                      ctrl.close()
                      return
                    }
                    if (value.type === 'error') throw value.error
                    if (!['stream-start', 'response-metadata', 'raw'].includes(value.type))
                      nextDeadline = Date.now() + limits.chunkMs
                    if (value.type === 'finish') {
                      if (
                        value.finishReason.unified === 'error' ||
                        (value.finishReason.unified === 'other' && !value.finishReason.raw)
                      )
                        throw new Error('Provider stream ended before completion')
                      finished = true
                      for (const part of buffered) ctrl.enqueue(part)
                      buffered.length = 0
                      ctrl.enqueue(value)
                      options.onRecovery?.(undefined)
                      ctrl.close()
                      void reader!.cancel().catch(() => {})
                      return
                    }
                    if (value.type.startsWith('tool-') || buffered.length) {
                      buffered.push(value)
                      continue
                    }
                    ctrl.enqueue(
                      value.type === 'text-start' ||
                        value.type === 'text-delta' ||
                        value.type === 'text-end' ||
                        value.type === 'reasoning-start' ||
                        value.type === 'reasoning-delta' ||
                        value.type === 'reasoning-end'
                        ? {
                            ...value,
                            providerMetadata: {
                              ...('providerMetadata' in value ? value.providerMetadata : undefined),
                              atermRecovery: { sample: sampleId }
                            }
                          }
                        : value
                    )
                    return
                  }
                } catch (error) {
                  controller.abort()
                  void reader!.cancel().catch(() => {})
                  buffered.length = 0
                  try {
                    let repairedContext = false
                    if (isContextOverflow(error) && options.repairContext && repairs < 2) {
                      repairs++
                      repaired = await options.repairContext(current)
                      repairedContext = true
                    }
                    if (repairedContext || (await retry(error))) {
                      options.onDiscardSample?.(sampleId)
                      // Native SDK retries this sample and creates its attempt boundary.
                      ctrl.enqueue({ type: 'error', error })
                      ctrl.close()
                    } else ctrl.error(error)
                  } catch (abort) {
                    ctrl.error(abort)
                  }
                }
              },
              cancel() {
                controller.abort()
                void reader!.cancel().catch(() => {})
              }
            })
            return { ...result, stream }
          } catch (error) {
            controller.abort()
            options.signal.throwIfAborted()
            if (isContextOverflow(error) && options.repairContext && repairs < 2) {
              repairs++
              current = await options.repairContext(current)
              repaired = current
              continue
            }
            if (!(await retry(error))) throw error
          }
        }
      }
    }
  })
}
