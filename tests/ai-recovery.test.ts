// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { isBusy, useAiStore, type AiSession } from '../src/renderer/src/stores/ai'
import type { AiContextUsage, AiUIMessage } from '../src/shared/types'
import type { UIMessageChunk } from 'ai'

// 测真实 AbstractChat 与 IPC transport，避免 mock 掉错误/中断的状态转换。
let id: string
let messages: AiUIMessage[]
let ai: {
  run: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  getMessages: ReturnType<typeof vi.fn>
}
const state = (): AiSession => useAiStore.getState().sessions.find((s) => s.id === id)!
const turn = (): string => ai.run.mock.calls.at(-1)![2] as string
const chunk = (value: UIMessageChunk, turnId = turn()): void =>
  useAiStore.getState().applyEvent({ type: 'chunk', sessionId: id, turnId, chunk: value })
const end = (turnId = turn()): void =>
  useAiStore.getState().applyEvent({ type: 'turn-end', sessionId: id, turnId })
const send = async (text: string): Promise<void> => {
  const calls = ai.run.mock.calls.length
  useAiStore.getState().send(text)
  await vi.waitFor(() => expect(ai.run).toHaveBeenCalledTimes(calls + 1))
}
const ready = (): Promise<void> => vi.waitFor(() => expect(isBusy(state())).toBe(false))

beforeEach(() => {
  id = crypto.randomUUID()
  messages = []
  ai = {
    run: vi.fn(async (_id: string, incoming: AiUIMessage[]) => {
      messages = structuredClone(incoming)
    }),
    cancel: vi.fn(async () => messages),
    getMessages: vi.fn(async () => messages)
  }
  Object.defineProperty(window, 'aterm', { configurable: true, value: { ai } })
  useAiStore.setState({
    activeId: id,
    sessions: [
      { id, title: '', createdAt: 1, updatedAt: 1, messages: [], loaded: true, status: 'ready' }
    ]
  })
})

it('上下文事件隔离旧回合，并从持久化历史恢复占用信息', async () => {
  await send('A')
  const usage: AiContextUsage = {
    modelKey: 'model',
    contextWindow: 32768,
    inputTokens: 1234,
    source: 'estimate',
    phase: 'compressing'
  }
  useAiStore.getState().applyEvent({ type: 'context-usage', sessionId: id, turnId: 'stale', usage })
  expect(state().contextUsage).toBeUndefined()
  useAiStore.getState().applyEvent({ type: 'context-usage', sessionId: id, turnId: turn(), usage })
  expect(state().contextUsage).toEqual(usage)
  const final: AiContextUsage = { ...usage, phase: 'ready', source: 'provider', inputTokens: 900 }
  messages.push({
    id: 'assistant',
    role: 'assistant',
    parts: [],
    metadata: { createdAt: 1, contextUsage: final }
  })
  end()
  await ready()
  await vi.waitFor(() => expect(state().contextUsage).toEqual(final))
  expect(ai.run).toHaveBeenCalledTimes(1)
})

it('网络失败等待后端收尾后解除忙碌，并能在同一会话继续发送', async () => {
  await send('A')
  chunk({ type: 'error', errorText: 'network disconnected' })
  expect(isBusy(state())).toBe(true)
  end()
  await ready()
  expect(state().status).toBe('error')
  expect(state().error?.message).toBe('network disconnected')
  await send('B')
  end()
  await ready()
  expect(state().status).toBe('ready')
})

it('IPC 建立失败也可再次发送', async () => {
  ai.run.mockRejectedValueOnce(new Error('session is busy'))
  await send('A')
  await ready()
  expect(state().error?.message).toBe('session is busy')
  await send('B')
  end()
  await ready()
})

it('停止必须等待主进程确认与本地流结束，旧回合事件不能关闭新流', async () => {
  await send('A')
  const oldTurn = turn()
  let acknowledge!: (value: AiUIMessage[]) => void
  ai.cancel.mockImplementationOnce(
    () =>
      new Promise<AiUIMessage[]>((r) => {
        acknowledge = r
      })
  )
  useAiStore.getState().cancel()
  expect(state().stopping).toBe(true)
  expect(ai.cancel).toHaveBeenCalledWith(id, oldTurn)
  useAiStore.getState().send('too early')
  expect(ai.run).toHaveBeenCalledTimes(1)
  const stopped: AiUIMessage = {
    id: 'stopped',
    role: 'assistant',
    parts: [],
    metadata: { createdAt: 1, interrupted: true }
  }
  messages = [...messages, stopped]
  acknowledge(messages)
  await Promise.resolve()
  expect(state().stopping).toBe(true)
  chunk({ type: 'abort' })
  end()
  await ready()
  expect(state().messages.at(-1)?.metadata?.interrupted).toBe(true)

  await send('B')
  expect(ai.run.mock.calls[1][1]).toContainEqual(stopped)
  chunk({ type: 'error', errorText: 'late old error' }, oldTurn)
  end(oldTurn)
  expect(isBusy(state())).toBe(true)
  expect(state().error).toBeUndefined()
  end()
  await ready()
})

it('停止待审批任务不会自动调用模型，停止期间的后台通知也不会唤醒它', async () => {
  const pending: AiUIMessage = {
    id: 'approval',
    role: 'assistant',
    metadata: { createdAt: 1 },
    parts: [
      {
        type: 'tool-probe',
        toolCallId: 'tool',
        input: {},
        state: 'approval-requested',
        approval: { id: 'approval-1' }
      }
    ]
  }
  useAiStore.setState({ sessions: [{ ...state(), messages: [pending] }] })
  messages = [{ ...pending, metadata: { createdAt: 1, interrupted: true }, parts: [] }]
  useAiStore.getState().cancel()
  useAiStore
    .getState()
    .applyEvent({ type: 'notify', sessionId: id, text: 'old execution finished' })
  await ready()
  expect(ai.run).not.toHaveBeenCalled()
  await send('B')
  end()
  await ready()
  expect(ai.run).toHaveBeenCalledTimes(1)
})

it('上一轮迟到的历史水合不能覆盖新回合消息', async () => {
  await send('A')
  let resolveOld!: (messages: AiUIMessage[]) => void
  ai.getMessages.mockImplementationOnce(
    () =>
      new Promise<AiUIMessage[]>((r) => {
        resolveOld = r
      })
  )
  end()
  await ready()
  await vi.waitFor(() => expect(resolveOld).toBeTypeOf('function'))
  await send('B')
  end()
  await ready()
  const latest = state().messages
  resolveOld([])
  await Promise.resolve()
  await Promise.resolve()
  expect(state().messages).toEqual(latest)
  expect(state().messages.some((m) => m.metadata?.display === 'B')).toBe(true)
})
