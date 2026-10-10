import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { HumanInputRequest, HumanInputOutcome } from '../../shared/execution'

export class BrowserHumanInputManager extends EventEmitter {
  private pending = new Map<
    string,
    {
      request: HumanInputRequest
      fill: (value: string) => Promise<void>
      settle: (outcome: HumanInputOutcome) => void
      submitting: boolean
    }
  >()
  list(sessionId?: string): HumanInputRequest[] {
    return [...this.pending.values()]
      .map((e) => e.request)
      .filter((r) => !sessionId || r.sessionId === sessionId)
  }
  ask(
    context: { sessionId: string; tabId: string; url: string; prompt: string },
    fill: (value: string) => Promise<void>,
    signal?: AbortSignal
  ): Promise<{ humanInputOutcome: HumanInputOutcome }> {
    if (signal?.aborted) return Promise.resolve({ humanInputOutcome: 'cancelled' })
    const id = `browser-input:${randomUUID()}`
    return new Promise((resolve) => {
      const abort = (): void => settle('cancelled')
      const timer = setTimeout(() => settle('expired'), 5 * 60_000)
      const settle = (outcome: HumanInputOutcome): void => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.emit('resolved', { executionId: id, sessionId: context.sessionId, outcome })
        resolve({ humanInputOutcome: outcome })
      }
      const request: HumanInputRequest = {
        ...context,
        target: 'browser',
        executionId: id,
        hostId: '',
        command: '',
        expiresAt: Date.now() + 5 * 60_000
      }
      this.pending.set(id, { request, fill, settle, submitting: false })
      signal?.addEventListener('abort', abort, { once: true })
      this.emit('request', request)
    })
  }
  async submit(sessionId: string, id: string, value: string): Promise<void> {
    const entry = this.entry(sessionId, id)
    if (entry.submitting) throw new Error('Input already being submitted')
    if (!value || value.length > 24000) throw new Error('Invalid input length')
    entry.submitting = true
    try {
      await entry.fill(value)
      entry.settle('submitted')
    } catch {
      entry.settle('expired')
      throw new Error('Page or input changed; request a new input card')
    }
  }
  cancel(sessionId: string, id: string): void {
    this.entry(sessionId, id).settle('cancelled')
  }
  private entry(sessionId: string, id: string): NonNullable<ReturnType<typeof this.pending.get>> {
    const entry = this.pending.get(id)
    if (!entry || entry.request.sessionId !== sessionId)
      throw new Error('Input request not found in this conversation')
    return entry
  }
}
export const browserHumanInputs = new BrowserHumanInputManager()
