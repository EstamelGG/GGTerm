// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { useAiStore } from '../src/renderer/src/stores/ai'
import { useWorkspaceStore } from '../src/renderer/src/stores/workspace'

beforeEach(() => {
  useAiStore.setState({ sessions: [], activeId: null, initError: null, viewChatRequest: 0 })
})

it('启动时收起 Agent 面板', () => {
  expect(useWorkspaceStore.getInitialState().sidebarOpen).toBe(false)
})

it.each([[], [{ id: 'recent', title: '最近对话', createdAt: 1, updatedAt: 2 }]])(
  '加载会话列表时不自动打开历史或创建对话：%j',
  async (...summaries) => {
    const listSessions = vi.fn(async () => summaries)
    const getMessages = vi.fn()
    const createSession = vi.fn()
    Object.defineProperty(window, 'aterm', {
      configurable: true,
      value: { ai: { listSessions, getMessages, createSession } }
    })

    await useAiStore.getState().init()

    expect(useAiStore.getState().activeId).toBeNull()
    expect(useAiStore.getState().sessions.map((s) => s.id)).toEqual(summaries.map((s) => s.id))
    expect(getMessages).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
  }
)
