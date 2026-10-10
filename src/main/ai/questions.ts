import { EventEmitter } from 'node:events'
import type { AgentQuestion, AgentQuestionAnswer } from '../../shared/agentQuestion'

export class QuestionManager extends EventEmitter {
  private pending = new Map<
    string,
    { request: AgentQuestion; settle: (answer: AgentQuestionAnswer) => void }
  >()
  list(): AgentQuestion[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }
  ask(request: AgentQuestion, signal?: AbortSignal): Promise<AgentQuestionAnswer> {
    if (signal?.aborted) return Promise.resolve({ outcome: 'cancelled' })
    if (this.pending.has(request.toolCallId)) throw new Error('Question already pending')
    return new Promise((resolve) => {
      const abort = (): void => settle({ outcome: 'cancelled' })
      const settle = (answer: AgentQuestionAnswer): void => {
        this.pending.delete(request.toolCallId)
        signal?.removeEventListener('abort', abort)
        this.emit('resolved', request.toolCallId)
        resolve(answer)
      }
      this.pending.set(request.toolCallId, { request, settle })
      signal?.addEventListener('abort', abort, { once: true })
      this.emit('request', request)
    })
  }
  answer(sessionId: string, id: string, index: number | null, text?: string): void {
    const entry = this.entry(sessionId, id)
    if (index !== null && (!Number.isInteger(index) || !entry.request.options[index]))
      throw new Error('Invalid option')
    const answer = index === null ? text?.trim() : entry.request.options[index].label
    if (!answer || answer.length > 4000) throw new Error('Answer must contain 1–4000 characters')
    entry.settle({ outcome: 'answered', answer, optionIndex: index })
  }
  cancel(sessionId: string, id: string): void {
    this.entry(sessionId, id).settle({ outcome: 'cancelled' })
  }
  private entry(
    sessionId: string,
    id: string
  ): { request: AgentQuestion; settle: (answer: AgentQuestionAnswer) => void } {
    const entry = this.pending.get(id)
    if (!entry || entry.request.sessionId !== sessionId)
      throw new Error('Question not found in this conversation')
    return entry
  }
}
export const questions = new QuestionManager()
