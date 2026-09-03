import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getToolName, isToolUIPart, simulateReadableStream } from 'ai'
import type { DynamicToolUIPart, ToolUIPart, UIMessageChunk } from 'ai'
type ToolPart = ToolUIPart | DynamicToolUIPart
import { MockLanguageModelV3 } from 'ai/test'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { AiUIMessage } from '../src/shared/types'
import {
  initAgent,
  createAgentSession,
  startTurn,
  abortTurn,
  listAgentSessions,
  getAgentSession,
  type AgentDeps,
  type AgentTool
} from '../src/main/ai/agent'

/**
 * agent 冒烟（不依赖 UI）：
 *   hermetic 组用 MockLanguageModelV3 离线验证 UI 流片、UIMessage 持久化、失败路径、审批门、同一步多工具串行与中断；
 *   live 组（需 SPIKE_API_KEY）验证真实 openai-compatible 供应商端到端。
 */

const usage = {
  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined }
}

const finish = (reason: 'stop' | 'tool-calls'): LanguageModelV3StreamPart => ({
  type: 'finish',
  finishReason: { unified: reason, raw: undefined },
  usage
})

const step = (
  chunks: LanguageModelV3StreamPart[]
): { stream: ReadableStream<LanguageModelV3StreamPart> } => ({
  stream: simulateReadableStream({ chunks: [{ type: 'stream-start', warnings: [] }, ...chunks] })
})

const textStep = (text: string): LanguageModelV3StreamPart[] => [
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' }
]

const toolCall = (
  toolCallId: string,
  toolName: string,
  input = '{}'
): LanguageModelV3StreamPart => ({
  type: 'tool-call',
  toolCallId,
  toolName,
  input
})

const echoTools: AgentTool[] = [
  {
    name: 'echo_probe',
    description: 'echo the city',
    parameters: z.object({ city: z.string() }),
    handler: async (args) => ({ received: (args as { city: string }).city, ok: true })
  },
  {
    name: 'fail_probe',
    description: 'always fail',
    parameters: z.object({}),
    handler: async () => {
      throw new Error('磁盘已满')
    }
  }
]

const user = (text: string): AiUIMessage => ({
  id: `u-${text}`,
  role: 'user',
  parts: [{ type: 'text', text }],
  metadata: { createdAt: Date.now() }
})

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = []
  for await (const c of stream) out.push(c)
  return out
}

const toolParts = (m: AiUIMessage): ToolPart[] => m.parts.filter(isToolUIPart)

const live = Boolean(process.env.SPIKE_API_KEY)

describe('agent（离线 mock 模型）', () => {
  let dir = ''

  const reinit = (
    model: MockLanguageModelV3,
    tools: AgentTool[] = echoTools,
    extra: Partial<AgentDeps> = {}
  ): void => {
    initAgent({
      storageDir: dir,
      getModel: () => model,
      tools,
      instructions: 'test system',
      ...extra
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aterm-agent-'))
    reinit(new MockLanguageModelV3({ doStream: async () => step([]) }))
  })

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('工具往返：UI 流片、UIMessage 持久化、会话列表', async () => {
    const session = createAgentSession()
    reinit(
      new MockLanguageModelV3({
        doStream: [
          step([
            { type: 'reasoning-start', id: 'reasoning-0' },
            { type: 'reasoning-delta', id: 'reasoning-0', delta: 'thinking about ' },
            { type: 'reasoning-delta', id: 'reasoning-0', delta: 'it' },
            { type: 'reasoning-end', id: 'reasoning-0' },
            ...textStep('calling echo_probe'),
            toolCall('call-1', 'echo_probe', JSON.stringify({ city: 'Hangzhou' })),
            finish('tool-calls')
          ]),
          step([
            // 供应商每步复用 reasoning-0：SDK 按 start/end 各自成块，不跨步累积
            { type: 'reasoning-start', id: 'reasoning-0' },
            { type: 'reasoning-delta', id: 'reasoning-0', delta: 'second thought' },
            { type: 'reasoning-end', id: 'reasoning-0' },
            ...textStep('done.'),
            finish('stop')
          ])
        ]
      })
    )

    const chunks = await collect(startTurn(session.id, [user('probe Hangzhou please')]))
    const types = chunks.map((c) => c.type)
    expect(types[0]).toBe('start')
    expect(types.at(-1)).toBe('finish')
    expect(types.indexOf('tool-input-available')).toBeLessThan(
      types.indexOf('tool-output-available')
    )

    const { messages } = getAgentSession(session.id)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: 'probe Hangzhou please' }]
    })
    const assistant = messages[1]
    expect(assistant.metadata?.createdAt).toBeTypeOf('number')
    expect(assistant.parts.filter((p) => p.type !== 'step-start').map((p) => p.type)).toEqual([
      'reasoning',
      'text',
      'tool-echo_probe',
      'reasoning',
      'text'
    ])
    const reasoning = assistant.parts.filter((p) => p.type === 'reasoning')
    expect(reasoning.map((p) => p.text)).toEqual(['thinking about it', 'second thought'])
    expect(toolParts(assistant)[0]).toMatchObject({
      state: 'output-available',
      input: { city: 'Hangzhou' },
      output: { received: 'Hangzhou', ok: true }
    })

    expect(listAgentSessions().map((s) => s.id)).toContain(session.id)
    expect(JSON.parse(readFileSync(join(dir, `${session.id}.json`), 'utf8')).messages).toHaveLength(
      2
    )
  })

  it('失败路径：工具抛错 → tool-output-error 流片与 output-error 持久化', async () => {
    const session = createAgentSession()
    reinit(
      new MockLanguageModelV3({
        doStream: [
          step([toolCall('call-2', 'fail_probe'), finish('tool-calls')]),
          step([...textStep('failed as expected'), finish('stop')])
        ]
      })
    )

    const chunks = await collect(startTurn(session.id, [user('try fail_probe')]))
    expect(chunks.find((c) => c.type === 'tool-output-error')).toMatchObject({
      errorText: '磁盘已满'
    })
    expect(toolParts(getAgentSession(session.id).messages[1])[0]).toMatchObject({
      state: 'output-error',
      errorText: '磁盘已满'
    })
  })

  it('审批门：自动拦截 → 拒绝响应（理由回传模型，循环继续），handler 不执行', async () => {
    const session = createAgentSession()
    let ran = false
    reinit(
      new MockLanguageModelV3({
        doStream: [
          step([toolCall('call-g', 'echo_probe', '{"city":"x"}'), finish('tool-calls')]),
          step([...textStep('denied ok'), finish('stop')])
        ]
      }),
      [{ ...echoTools[0], handler: async () => ((ran = true), { ok: true }) }],
      { gate: () => ({ type: 'denied', reason: 'policy' }) }
    )

    await collect(startTurn(session.id, [user('gate me')]))
    expect(ran).toBe(false)
    const assistant = getAgentSession(session.id).messages[1]
    // 同一流内的自动拒绝：SDK 以 approval-responded(approved=false) 落定，模型收到 execution-denied 后继续生成
    expect(toolParts(assistant)[0]).toMatchObject({
      state: 'approval-responded',
      approval: { approved: false, isAutomatic: true, reason: 'policy' }
    })
    expect(assistant.parts.some((p) => p.type === 'text' && p.text === 'denied ok')).toBe(true)
  })

  it('审批门：人工审批结束回合；写回批准后续跑同一条 assistant 消息并执行工具', async () => {
    const session = createAgentSession()
    reinit(
      new MockLanguageModelV3({
        doStream: [
          step([toolCall('call-a', 'echo_probe', '{"city":"Hangzhou"}'), finish('tool-calls')]),
          step([...textStep('approved and done'), finish('stop')])
        ]
      }),
      echoTools,
      { gate: () => ({ type: 'user-approval', reason: 'echo Hangzhou' }) }
    )

    await collect(startTurn(session.id, [user('need approval')]))
    const { messages } = getAgentSession(session.id)
    const pending = toolParts(messages[1])[0]
    expect(pending).toMatchObject({
      state: 'approval-requested',
      approval: { requestReason: 'echo Hangzhou' }
    })
    if (pending.state !== 'approval-requested') throw new Error('unreachable')

    // 渲染层 addToolApprovalResponse 的等价写回，随后以完整历史续跑
    const responded: AiUIMessage = {
      ...messages[1],
      parts: messages[1].parts.map((p) =>
        p === pending
          ? { ...p, state: 'approval-responded', approval: { ...p.approval, approved: true } }
          : p
      )
    }
    const chunks = await collect(startTurn(session.id, [messages[0], responded]))
    expect(chunks[0]).toMatchObject({ type: 'start', messageId: messages[1].id })

    const final = getAgentSession(session.id).messages
    expect(final).toHaveLength(2)
    expect(final[1].id).toBe(messages[1].id)
    expect(toolParts(final[1])[0]).toMatchObject({
      state: 'output-available',
      output: { received: 'Hangzhou', ok: true },
      approval: { approved: true }
    })
    expect(final[1].parts.some((p) => p.type === 'text' && p.text === 'approved and done')).toBe(
      true
    )
  })

  it('同一步多工具：同键按 tool call / 卡片顺序串行执行', { timeout: 15_000 }, async () => {
    const marks: Record<string, number> = {}
    const probe = (name: string, ms: number): AgentTool => ({
      name,
      parameters: z.object({}),
      // 同键 = 同一资源（同一主机 / 同一 execution），必须保序
      lockKey: () => 'host:1',
      handler: async () => {
        marks[`${name}Start`] = Date.now()
        await new Promise((r) => setTimeout(r, ms))
        marks[`${name}End`] = Date.now()
        return { ok: true }
      }
    })
    const session = createAgentSession()
    reinit(
      new MockLanguageModelV3({
        doStream: [
          step([toolCall('p-fast', 'fast'), toolCall('p-slow', 'slow'), finish('tool-calls')]),
          step([...textStep('both done'), finish('stop')])
        ]
      }),
      [probe('fast', 100), probe('slow', 300)]
    )

    const chunks = await collect(startTurn(session.id, [user('run both')]))
    // 串行判据：后声明的 slow 须等先声明的 fast 结束才启动
    expect(marks.slowStart).toBeGreaterThanOrEqual(marks.fastEnd)
    const cards = toolParts(getAgentSession(session.id).messages[1])
    expect(cards.map((c) => getToolName(c))).toEqual(['fast', 'slow'])
    expect(cards.every((c) => c.state === 'output-available')).toBe(true)
    expect(chunks.filter((c) => c.type === 'tool-output-available')).toHaveLength(2)
  })

  it('同一步多工具：不同键并行执行，互不排队', { timeout: 15_000 }, async () => {
    const marks: Record<string, number> = {}
    const probe = (name: string, ms: number, key: string | null): AgentTool => ({
      name,
      parameters: z.object({}),
      lockKey: () => key,
      handler: async () => {
        marks[`${name}Start`] = Date.now()
        await new Promise((r) => setTimeout(r, ms))
        marks[`${name}End`] = Date.now()
        return { ok: true }
      }
    })
    const session = createAgentSession()
    reinit(
      new MockLanguageModelV3({
        doStream: [
          step([toolCall('p-a', 'a'), toolCall('p-b', 'b'), finish('tool-calls')]),
          step([...textStep('both done'), finish('stop')])
        ]
      }),
      [probe('a', 400, 'host:1'), probe('b', 50, 'host:2')]
    )

    await collect(startTurn(session.id, [user('run both')]))
    // 并行判据：后声明的 b 不等先声明的 a 结束就已启动（不同键不互斥）
    expect(marks.bStart).toBeLessThan(marks.aEnd)
  })

  it('同一步多工具：无键（只读/纯计算）不受同主机长任务阻塞', { timeout: 15_000 }, async () => {
    const marks: Record<string, number> = {}
    const busy = (name: string, ms: number, key: string | null): AgentTool => ({
      name,
      parameters: z.object({}),
      lockKey: () => key,
      handler: async () => {
        marks[`${name}Start`] = Date.now()
        await new Promise((r) => setTimeout(r, ms))
        marks[`${name}End`] = Date.now()
        return { ok: true }
      }
    })
    const session = createAgentSession()
    reinit(
      new MockLanguageModelV3({
        doStream: [
          step([toolCall('p-write', 'write'), toolCall('p-read', 'read'), finish('tool-calls')]),
          step([...textStep('both done'), finish('stop')])
        ]
      }),
      [busy('write', 400, 'host:1'), busy('read', 50, null)]
    )

    await collect(startTurn(session.id, [user('write then read')]))
    expect(marks.readStart).toBeLessThan(marks.writeEnd)
  })

  it(
    '中断：abort 后回合收敛，执行中的工具卡持久化为 Interrupted',
    { timeout: 20_000 },
    async () => {
      const session = createAgentSession()
      reinit(
        new MockLanguageModelV3({
          doStream: step([toolCall('call-3', 'slow_probe'), finish('tool-calls')])
        }),
        [
          {
            name: 'slow_probe',
            parameters: z.object({}),
            handler: () => new Promise((r) => setTimeout(() => r({ ok: true }), 5000))
          }
        ]
      )

      const running = collect(startTurn(session.id, [user('slow operation')]))
      await new Promise((r) => setTimeout(r, 300))
      abortTurn(session.id)
      const chunks = await running
      expect(chunks.some((c) => c.type === 'abort')).toBe(true)
      expect(chunks.some((c) => c.type === 'error')).toBe(false)
      const { messages } = getAgentSession(session.id)
      expect(messages).toHaveLength(2)
      expect(toolParts(messages[1])[0]).toMatchObject({
        state: 'output-error',
        errorText: 'Interrupted'
      })
    }
  )
})

describe.skipIf(!live)('agent（真实供应商 E2E）', () => {
  it('deepseek-reasoner：thinking 透传 + 工具往返 + 流不断', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aterm-agent-live-'))
    const model = createOpenAICompatible({
      name: 'live',
      baseURL: process.env.SPIKE_BASE_URL ?? 'https://api.deepseek.com',
      apiKey: process.env.SPIKE_API_KEY ?? ''
    }).chatModel(process.env.SPIKE_MODEL ?? 'deepseek-reasoner')
    initAgent({
      storageDir: dir,
      getModel: () => model,
      tools: echoTools,
      instructions: '你是链路测试助手，回答一句话。'
    })
    try {
      const session = createAgentSession()
      const chunks = await collect(
        startTurn(session.id, [user('请调用 echo_probe（city 填 Hangzhou），然后一句话总结。')])
      )
      expect(chunks.some((c) => c.type === 'reasoning-delta')).toBe(true)
      expect(chunks.some((c) => c.type === 'tool-output-available')).toBe(true)
      expect(chunks.at(-1)?.type).toBe('finish')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
