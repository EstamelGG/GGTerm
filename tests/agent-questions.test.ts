import { expect, it } from 'vitest'
import { QuestionManager } from '../src/main/ai/questions'
import { questionParameters } from '../src/main/ai/tools/question'
const request = {
  sessionId: 's',
  toolCallId: 'q',
  question: '目标？',
  options: [{ label: '检查' }, { label: '修复' }]
}
it('waits for explicit choice and rejects cross-session or invalid answers', async () => {
  const manager = new QuestionManager()
  const result = manager.ask(request)
  expect(manager.list()).toEqual([request])
  expect(() => manager.answer('other', 'q', 0)).toThrow()
  expect(() => manager.answer('s', 'q', 3)).toThrow()
  manager.answer('s', 'q', 1)
  expect(await result).toEqual({ outcome: 'answered', answer: '修复', optionIndex: 1 })
  expect(manager.list()).toEqual([])
  expect(() => manager.answer('s', 'q', 1)).toThrow()
})
it('validates Other input, and cancels waiting questions on turn abort', async () => {
  const manager = new QuestionManager()
  const result = manager.ask(request)
  expect(() => manager.answer('s', 'q', null, ' ')).toThrow()
  manager.answer('s', 'q', null, ' 自定义目标 ')
  expect(await result).toEqual({ outcome: 'answered', answer: '自定义目标', optionIndex: null })
  const controller = new AbortController()
  const cancelled = manager.ask(request, controller.signal)
  controller.abort()
  expect(await cancelled).toEqual({ outcome: 'cancelled' })
  expect(manager.list()).toEqual([])
})
it('limits questions to at most three options', () => {
  expect(
    questionParameters.safeParse({ question: '目标', options: Array(4).fill({ label: '选项' }) })
      .success
  ).toBe(false)
})
