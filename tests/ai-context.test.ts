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

it('长任务在同一用户回合内压缩已完成工具步骤，保留最新请求及最近调用/结果', async () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'Diagnose host=h1; do not restart services.' }
  ]
  for (let i = 0; i < 10; i++) {
    messages.push(
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: `t${i}`, toolName: 'read', input: { path: `/log/${i}` } }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: `t${i}`,
            toolName: 'read',
            output: { type: 'text', value: 'log '.repeat(100) }
          }
        ]
      }
    )
  }
  const original = structuredClone(messages)
  const config = options()
  const fitted = await compactContext({ ...config, messages })
  expect(fitted.compressed).toBe(true)
  expect(fitted.summary?.pinnedUserIndex).toBe(0)
  expect(fitted.messages[1]).toEqual(messages[0])
  expect(fitted.messages.slice(-2)).toEqual(messages.slice(-2))
  expect(estimateTokens(fitted.messages)).toBeLessThanOrEqual(config.budget)
  expect(messages).toEqual(original)
  config.summarize.mockClear()
  const reused = await compactContext({ ...config, messages, cached: fitted.summary })
  expect(reused.messages[1]).toEqual(messages[0])
  expect(config.summarize).not.toHaveBeenCalled()
})

it('单个超大工具输出只缩减模型输入，原始日志和工具配对保留', async () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'Read logs' },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'large', toolName: 'read', input: {} }]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'large',
          toolName: 'read',
          output: { type: 'text', value: 'START\n' + 'x'.repeat(20_000) + '\nEND' }
        }
      ]
    }
  ]
  const fitted = await compactContext({ ...options(), messages })
  expect(estimateTokens(fitted.messages)).toBeLessThanOrEqual(1000)
  expect(JSON.stringify(fitted.messages)).toContain('shortened for model context')
  expect(JSON.stringify(fitted.messages)).toContain('START')
  expect(JSON.stringify(fitted.messages)).toContain('END')
  expect(JSON.stringify(messages)).toContain('x'.repeat(20_000))
  const ids = fitted.messages
    .filter((m) => m.role === 'assistant' || m.role === 'tool')
    .flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((p) => 'toolCallId' in p).map((p) => p.toolCallId)
        : []
    )
  expect(ids).toEqual(['large', 'large'])
})

it('强制压缩即使低于配置阈值也会明显减小输入', async () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'x'.repeat(4000) },
    { role: 'user', content: 'current' }
  ]
  const before = estimateTokens(messages)
  const fitted = await compactContext({ ...options(), budget: 20_000, force: true, messages })
  expect(estimateTokens(fitted.messages)).toBeLessThan(before * 0.55)
  expect(fitted.messages.at(-1)).toEqual(messages.at(-1))
})

it('不能在未配对的工具调用之前切割上下文', async () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'request' },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'pending', toolName: 'read', input: {} }]
    },
    { role: 'assistant', content: 'x'.repeat(4000) }
  ]
  await expect(compactContext({ ...options(), messages })).rejects.toThrow('context budget')
})
