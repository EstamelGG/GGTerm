import { expect, it, vi, type Mock } from 'vitest'
import type { ModelMessage } from 'ai'
import { compactContext, estimateTokens } from '../src/main/ai/context'
import { contextSettingsFor, modelSettingsKey, AI_DEFAULTS } from '../src/shared/ai'

const options = (): {
  budget: number
  autoCompress: boolean
  signal: AbortSignal
  summarize: Mock<() => Promise<string>>
} => ({
  budget: 1000,
  autoCompress: true,
  signal: new AbortController().signal,
  summarize: vi.fn(
    async () =>
      'Old request completed; host=h1, execution=e1. Task A was interrupted; do not resume it without an explicit request.'
  )
})

it('摘要完整旧回合，不拆散当前工具调用和结果，且不修改完整历史', async () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: 'x'.repeat(5000) },
    { role: 'user', content: 'new request' },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 't', toolName: 'probe', input: {} }]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 't',
          toolName: 'probe',
          output: { type: 'text', value: 'done' }
        }
      ]
    }
  ]
  const config = options()
  const fitted = await compactContext({ ...config, messages })
  expect(fitted.compressed).toBe(true)
  expect(estimateTokens(fitted.messages)).toBeLessThanOrEqual(1000)
  expect(fitted.messages.slice(1)).toEqual(messages.slice(2))
  expect(messages).toHaveLength(5)
  expect(config.summarize.mock.calls.length).toBeGreaterThan(1)
  config.summarize.mockClear()
  const reused = await compactContext({ ...config, messages, cached: fitted.summary })
  expect(reused.messages).toEqual(fitted.messages)
  expect(config.summarize).not.toHaveBeenCalled()
  await compactContext({
    ...config,
    cached: fitted.summary,
    messages: [{ role: 'user', content: 'changed' }, ...messages.slice(1)]
  })
  expect(config.summarize).toHaveBeenCalled()
})

it('当前请求或本轮工具结果过大时明确报错，不静默截断或丢失操作记录', async () => {
  await expect(
    compactContext({ ...options(), messages: [{ role: 'user', content: 'x'.repeat(4000) }] })
  ).rejects.toThrow('context budget')
})

it('预算内保持历史和思考链原样（由调用方处理历史思考链）', async () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }]
  expect((await compactContext({ ...options(), messages })).messages).toBe(messages)
})

it('摘要失败或取消时不替换历史；关闭压缩时明确报错', async () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'x'.repeat(4000) },
    { role: 'user', content: 'B' }
  ]
  await expect(compactContext({ ...options(), messages, autoCompress: false })).rejects.toThrow(
    'enable automatic compression'
  )
  await expect(
    compactContext({ ...options(), messages, summarize: async () => '' })
  ).rejects.toThrow('summary is empty')
  const controller = new AbortController()
  await expect(
    compactContext({
      ...options(),
      messages,
      signal: controller.signal,
      summarize: async () => {
        controller.abort()
        return 'summary'
      }
    })
  ).rejects.toThrow()
  expect(messages[0].content).toHaveLength(4000)
})

it('不同供应商/模型分别保存设置，支持 1M，并对旧配置和无效值提供默认值', () => {
  const one = { providerId: 'one', model: 'large' }
  const two = { providerId: 'two', model: 'large' }
  const config = {
    ...AI_DEFAULTS,
    modelSettings: { [modelSettingsKey(one)]: { contextWindow: 1_048_576, autoCompress: false } }
  }
  expect(contextSettingsFor(config, one)).toEqual({ contextWindow: 1_048_576, autoCompress: false })
  expect(contextSettingsFor(config, two)).toEqual({ contextWindow: 32_768, autoCompress: true })
  expect(
    contextSettingsFor(
      {
        ...config,
        modelSettings: { [modelSettingsKey(one)]: { contextWindow: NaN, autoCompress: true } }
      },
      one
    ).contextWindow
  ).toBe(32_768)
})
