import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simulateReadableStream } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createServer } from 'node:http'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { z } from 'zod'
import {
  initAgent,
  createAgentSession,
  startTurn,
  getAgentSession,
  abortTurn,
  type AgentDeps
} from '../src/main/ai/agent'
import { isContextOverflow, recoveryReason } from '../src/main/ai/recovery'
import type { AiRecoveryState, AiUIMessage } from '../src/shared/types'

const usage = {
  inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined }
}
const finish = (reason: 'stop' | 'tool-calls' = 'stop'): LanguageModelV3StreamPart => ({
  type: 'finish',
  finishReason: { unified: reason, raw: undefined },
  usage
})
const text = (value: string): LanguageModelV3StreamPart[] => [
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: value },
  { type: 'text-end', id: 't' }
]
const response = (
  ...chunks: LanguageModelV3StreamPart[]
): { stream: ReadableStream<LanguageModelV3StreamPart> } => ({
  stream: simulateReadableStream({ chunks: [{ type: 'stream-start', warnings: [] }, ...chunks] })
})
const user = (value: string): AiUIMessage => ({
  id: crypto.randomUUID(),
  role: 'user',
  parts: [{ type: 'text', text: value }],
  metadata: { createdAt: 1 }
})
const drain = async (stream: ReturnType<typeof startTurn>): Promise<unknown[]> => {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aterm-recovery-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})
const setup = (
  model: MockLanguageModelV3,
  extra: Partial<AgentDeps> = {}
): ReturnType<typeof createAgentSession> => {
  initAgent({
    storageDir: dir,
    getModel: () => model,
    tools: [],
    instructions: 'Test',
    recoveryDelays: [0, 0, 0],
    ...extra
  })
  return createAgentSession()
}

it('classifies transient faults, context overflows and permanent auth/quota errors separately', () => {
  expect(recoveryReason({ statusCode: 429 })).toBe('rate-limit')
  expect(recoveryReason({ statusCode: 503 })).toBe('server')
  expect(recoveryReason(new TypeError('fetch failed'))).toBe('network')
  expect(recoveryReason({ cause: { code: 'ECONNRESET' } })).toBe('network')
  expect(recoveryReason({ statusCode: 401, isRetryable: true })).toBeUndefined()
  expect(recoveryReason({ statusCode: 429, responseBody: 'insufficient_quota' })).toBeUndefined()
  expect(isContextOverflow({ statusCode: 400, responseBody: 'context_length_exceeded' })).toBe(true)
  expect(recoveryReason(new Error('maximum context length exceeded'))).toBeUndefined()
})

it('automatically recovers an initial request, keeping the same turn and showing bounded recovery state', async () => {
  let calls = 0
  const model = new MockLanguageModelV3({
    doStream: async () => {
      if (calls++ < 2) throw new Error('fetch failed')
      return response(...text('Recovered'), finish())
    }
  })
  const states: (AiRecoveryState | undefined)[] = []
  const session = setup(model, { onRecovery: (_session, _turn, value) => states.push(value) })
  await drain(startTurn(session.id, [user('Continue')], 'one-turn'))
  expect(calls).toBe(3)
  expect(states.filter(Boolean).map((s) => s!.attempt)).toEqual([1, 2])
  expect(states.at(-1)).toBeUndefined()
  expect(getAgentSession(session.id).messages.at(-1)?.metadata?.error).toBeUndefined()
})

it('never repeats completed tools or executes tool calls from a disconnected sample', async () => {
  const handler = vi.fn(async () => 'saved')
  let calls = 0
  const tool = (id: string): LanguageModelV3StreamPart => ({
    type: 'tool-call',
    toolCallId: id,
    toolName: 'save',
    input: '{}'
  })
  const model = new MockLanguageModelV3({
    doStream: async () => {
      switch (calls++) {
        case 0:
          return response(tool('completed'), finish('tool-calls'))
        case 1:
          return response(...text('Partial'), tool('discarded'), {
            type: 'error',
            error: new Error('network disconnected')
          })
        default:
          return response(...text('Recovered'), finish())
      }
    }
  })
  const session = setup(model, { tools: [{ name: 'save', parameters: z.object({}), handler }] })
  await drain(startTurn(session.id, [user('Save')]))
  expect(calls).toBe(3)
  expect(handler).toHaveBeenCalledTimes(1)
  expect(handler.mock.calls[0][1].toolCallId).toBe('completed')
  const record = getAgentSession(session.id)
  expect(record.messages.at(-1)?.metadata?.error).toBeUndefined()
  expect(JSON.stringify(record.messages.at(-1)?.parts)).not.toContain('Partial')
  expect(JSON.stringify(record.messages.at(-1)?.parts)).not.toContain('atermRecovery')
  expect(JSON.stringify(model.doStreamCalls[2].prompt)).toContain('completed')
  expect(JSON.stringify(model.doStreamCalls[2].prompt)).not.toContain('discarded')
})

it('recovers premature EOF and reader errors instead of silently treating partial responses as success', async () => {
  let calls = 0
  const model = new MockLanguageModelV3({
    doStream: async () => {
      if (calls++ === 0) return response(...text('Partial'))
      if (calls === 2)
        return {
          stream: new ReadableStream({
            start(ctrl) {
              ctrl.error(new Error('socket terminated'))
            }
          })
        }
      return response(...text('Recovered'), finish())
    }
  })
  const session = setup(model)
  await drain(startTurn(session.id, [user('A')]))
  expect(calls).toBe(3)
  expect(getAgentSession(session.id).messages.at(-1)?.metadata?.error).toBeUndefined()
})

it('stops after the shared retry budget and discards failed tools even on final failure', async () => {
  const handler = vi.fn()
  const model = new MockLanguageModelV3({
    doStream: async () =>
      response(
        { type: 'tool-call', toolCallId: 'unsafe', toolName: 'save', input: '{}' },
        { type: 'error', error: new Error('network disconnected') }
      )
  })
  const session = setup(model, {
    recoveryDelays: [0, 0],
    tools: [{ name: 'save', parameters: z.object({}), handler }]
  })
  await drain(startTurn(session.id, [user('A')]))
  expect(model.doStreamCalls).toHaveLength(3)
  expect(handler).not.toHaveBeenCalled()
  expect(getAgentSession(session.id).messages.at(-1)?.metadata?.error).toContain(
    'network disconnected'
  )
})

it('does not retry a permanent provider error', async () => {
  const model = new MockLanguageModelV3({
    doStream: async () => {
      throw Object.assign(new Error('Invalid API key'), { statusCode: 401 })
    }
  })
  const session = setup(model)
  await drain(startTurn(session.id, [user('A')]))
  expect(model.doStreamCalls).toHaveLength(1)
})

it('cancel interrupts the recovery wait immediately and never wakes up to retry', async () => {
  const model = new MockLanguageModelV3({
    doStream: async () => {
      throw new Error('fetch failed')
    }
  })
  const notified = vi.fn()
  const session = setup(model, { recoveryDelays: [30_000], onRecovery: notified })
  const running = drain(startTurn(session.id, [user('A')]))
  await vi.waitFor(() => expect(notified).toHaveBeenCalled())
  abortTurn(session.id)
  await running
  expect(model.doStreamCalls).toHaveLength(1)
  expect(getAgentSession(session.id).messages.at(-1)?.metadata?.interrupted).toBe(true)
})

it('recovers a stalled stream with a fresh per-attempt timeout', async () => {
  let calls = 0
  const model = new MockLanguageModelV3({
    doStream: async () => {
      if (calls++ === 0)
        return {
          stream: new ReadableStream({
            start(ctrl) {
              ctrl.enqueue({ type: 'stream-start', warnings: [] })
            }
          })
        }
      return response(...text('Recovered'), finish())
    }
  })
  const session = setup(model, { modelTimeout: { firstChunkMs: 25, chunkMs: 25 } })
  await drain(startTurn(session.id, [user('A')]))
  expect(calls).toBe(2)
  expect(getAgentSession(session.id).messages.at(-1)?.metadata?.error).toBeUndefined()
})

it('provider overflow below the configured threshold compacts and retries without replaying a turn', async () => {
  let calls = 0
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Previous task completed; preserve user constraints.' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: []
    }),
    doStream: async () => {
      if (calls++ === 0)
        throw Object.assign(new Error('maximum context length exceeded'), { statusCode: 400 })
      return response(...text('Recovered'), finish())
    }
  })
  const session = setup(model)
  const old: AiUIMessage = {
    id: 'old',
    role: 'assistant',
    parts: [{ type: 'text', text: 'old logs '.repeat(1000) }]
  }
  await drain(startTurn(session.id, [user('Old task'), old, user('Current request')]))
  expect(calls).toBe(2)
  expect(model.doGenerateCalls.length).toBeGreaterThan(0)
  expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('Earlier conversation summary')
  expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('Current request')
  expect(JSON.stringify(model.doStreamCalls[1].prompt)).not.toContain('old logs old logs')
  expect(getAgentSession(session.id).messages[1].parts).toEqual(old.parts)
  expect(getAgentSession(session.id).messages.at(-1)?.metadata?.contextCompressed).toBe(true)
  expect(getAgentSession(session.id).contextInputLimits).toBeDefined()
  // Reload the session from disk: the reduced budget must survive a restart.
  initAgent({ storageDir: dir, getModel: () => model, tools: [], instructions: 'Test' })
  await drain(startTurn(session.id, [...getAgentSession(session.id).messages, user('Continue')]))
  expect(calls).toBe(3)
  expect(JSON.stringify(model.doStreamCalls[2].prompt)).not.toContain('old logs old logs')
  expect(getAgentSession(session.id).contextSummary).toBeDefined()
  const summaries = model.doGenerateCalls.length
  await drain(
    startTurn(session.id, [...getAgentSession(session.id).messages, user('Continue again')])
  )
  expect(model.doGenerateCalls).toHaveLength(summaries)
})

it('recovers an actual OpenAI-compatible SSE disconnection against a local server', async () => {
  let calls = 0
  const server = createServer((_req, res) => {
    calls++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = (delta: object, reason: string | null = null): string =>
      `data: ${JSON.stringify({ id: 'chat', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`
    if (calls === 1) {
      res.write(event({ role: 'assistant', content: 'Broken partial' }))
      res.end()
    } else {
      res.write(event({ role: 'assistant', content: 'Recovered over HTTP' }))
      res.write(event({}, 'stop'))
      res.end('data: [DONE]\n\n')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server port')
    const model = createOpenAICompatible({
      name: 'test',
      baseURL: `http://127.0.0.1:${address.port}/v1`
    }).chatModel('test')
    initAgent({
      storageDir: dir,
      getModel: () => model,
      tools: [],
      instructions: 'Test',
      recoveryDelays: [0]
    })
    const session = createAgentSession()
    await drain(startTurn(session.id, [user('A')]))
    expect(calls).toBe(2)
    const result = getAgentSession(session.id).messages.at(-1)
    expect(result?.metadata?.error).toBeUndefined()
    expect(JSON.stringify(result?.parts)).toContain('Recovered over HTTP')
    expect(JSON.stringify(result?.parts)).not.toContain('Broken partial')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('compacts during a long tool loop within one user request without replaying completed steps', async () => {
  let calls = 0
  const handler = vi.fn(async () => 'observed logs '.repeat(300))
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: 'text',
          text: 'Diagnose host h1; do not restart. Earlier log reads completed; no changes made.'
        }
      ],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: []
    }),
    doStream: async () => {
      if (calls++ < 8)
        return response(
          { type: 'tool-call', toolCallId: `read-${calls}`, toolName: 'read', input: '{}' },
          finish('tool-calls')
        )
      return response(...text('Done'), finish())
    }
  })
  const session = setup(model, {
    getContextSettings: () => ({ contextWindow: 8192, autoCompress: true }),
    tools: [{ name: 'read', parameters: z.object({}), handler }]
  })
  await drain(startTurn(session.id, [user('Diagnose host h1; do not restart services.')]))
  expect(handler).toHaveBeenCalledTimes(8)
  expect(model.doGenerateCalls.length).toBeGreaterThan(0)
  expect(JSON.stringify(model.doStreamCalls.at(-1)?.prompt)).toContain(
    'Earlier conversation summary'
  )
  expect(JSON.stringify(model.doStreamCalls.at(-1)?.prompt)).toContain(
    'Diagnose host h1; do not restart services.'
  )
  const record = getAgentSession(session.id)
  expect(record.messages.at(-1)?.metadata?.error).toBeUndefined()
  expect(record.messages.at(-1)?.metadata?.contextCompressed).toBe(true)
  expect(JSON.stringify(record.messages)).toContain('observed logs '.repeat(300))
})

it('summary generation retries transient failures and then resumes the original request', async () => {
  let summaries = 0
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      if (summaries++ === 0) throw new Error('fetch failed')
      return {
        content: [{ type: 'text', text: 'Old task completed; preserve constraints.' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: []
      }
    },
    doStream: async () => response(...text('Done'), finish())
  })
  const session = setup(model, {
    getContextSettings: () => ({ contextWindow: 8192, autoCompress: true })
  })
  await drain(
    startTurn(session.id, [
      user('Old task'),
      { id: 'old', role: 'assistant', parts: [{ type: 'text', text: 'logs '.repeat(3000) }] },
      user('Current task')
    ])
  )
  expect(summaries).toBeGreaterThan(1)
  expect(model.doStreamCalls).toHaveLength(1)
  expect(getAgentSession(session.id).messages.at(-1)?.metadata?.error).toBeUndefined()
})

it('retries a truncated summary with a stricter size instruction', async () => {
  let summaries = 0
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Old task completed.' }],
      finishReason: { unified: summaries++ === 0 ? 'length' : 'stop', raw: undefined },
      usage,
      warnings: []
    }),
    doStream: async () => response(...text('Done'), finish())
  })
  const session = setup(model, {
    getContextSettings: () => ({ contextWindow: 8192, autoCompress: true })
  })
  await drain(
    startTurn(session.id, [
      user('Old'),
      { id: 'old', role: 'assistant', parts: [{ type: 'text', text: 'logs '.repeat(3000) }] },
      user('Current')
    ])
  )
  expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain(
    'Previous attempt failed: generation reached the output limit'
  )
  expect(getAgentSession(session.id).messages.at(-1)?.metadata?.error).toBeUndefined()
})

it('uses observed token counts to compact earlier on the next turn for the same model', async () => {
  const reported = { ...usage, inputTokens: { ...usage.inputTokens, total: 1000 } }
  let calls = 0
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Previous task completed.' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: []
    }),
    doStream: async () =>
      response(...text(calls++ === 0 ? 'observed '.repeat(350) : 'Done'), {
        ...finish(),
        usage: reported
      })
  })
  const session = setup(model, {
    getContextSettings: () => ({ contextWindow: 8192, autoCompress: true }),
    getModelKey: () => 'calibrated'
  })
  await drain(startTurn(session.id, [user('First')]))
  const record = getAgentSession(session.id)
  await drain(startTurn(session.id, [...record.messages, user('Next')]))
  expect(model.doGenerateCalls.length).toBeGreaterThan(0)
  expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('Earlier conversation summary')
})

it('repairs a context overflow delivered inside the stream', async () => {
  let calls = 0
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Old task completed.' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: []
    }),
    doStream: async () =>
      calls++ === 0
        ? response({
            type: 'error',
            error: Object.assign(new Error('context_length_exceeded'), { statusCode: 400 })
          })
        : response(...text('Done'), finish())
  })
  const session = setup(model)
  await drain(
    startTurn(session.id, [
      user('Old'),
      { id: 'old', role: 'assistant', parts: [{ type: 'text', text: 'logs '.repeat(1000) }] },
      user('Current')
    ])
  )
  expect(model.doStreamCalls).toHaveLength(2)
  expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('Earlier conversation summary')
  expect(getAgentSession(session.id).messages.at(-1)?.metadata?.error).toBeUndefined()
})
