// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NoteEditorDialog } from '../src/renderer/src/components/connection/NoteEditorDialog'
import { useAiStore } from '../src/renderer/src/stores/ai'
import { useWorkspaceStore } from '../src/renderer/src/stores/workspace'
import { useSessionStore } from '../src/renderer/src/stores/session'
import type { AiSessionSummary } from '../src/shared/types'

// t 原样回传 key（带插值参数），断言落在「用了哪个 key + 插了什么值」上
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}|${JSON.stringify(vars)}` : key
  })
}))

const summary = (id: string, title: string): AiSessionSummary => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1
})

let ai: {
  listSessions: ReturnType<typeof vi.fn>
  createSession: ReturnType<typeof vi.fn>
  getMessages: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  closeSession: ReturnType<typeof vi.fn>
}

/** 取某次 run 投出去的末条用户消息正文（UIMessage.parts[].text） */
const sentText = (call: unknown[]): string => {
  const messages = call[1] as { role: string; parts: { type: string; text?: string }[] }[]
  const last = messages.at(-1)!
  return last.parts.map((p) => p.text ?? '').join('')
}

beforeEach(() => {
  vi.clearAllMocks()
  useWorkspaceStore.setState({ aiOpen: false })
  useSessionStore.setState({ tab: { kind: 'connections' } })
  useAiStore.setState({ sessions: [], activeId: null, initError: null })
  ai = {
    listSessions: vi.fn(async () => [summary('old', '已有对话')]),
    createSession: vi.fn(async () => summary('new-1', '')),
    getMessages: vi.fn(async () => []),
    run: vi.fn(async () => {}),
    cancel: vi.fn(),
    closeSession: vi.fn()
  }
  Object.defineProperty(window, 'aterm', { configurable: true, value: { ai } })
})
afterEach(cleanup)

const renderDialog = (onDismiss: () => void): void => {
  render(
    <NoteEditorDialog
      hostId="h1"
      hostName="web-01"
      hostAddress="10.0.0.1:22"
      note={undefined}
      onDismiss={onDismiss}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'conn.note.agentFill' }))
}

it('creates a new session, sends the note prompt at once and opens the AI sidebar without switching the center', async () => {
  const onDismiss = vi.fn()
  renderDialog(onDismiss)

  // 提示词直达 agent：不落输入框、不等确认
  await waitFor(() => expect(ai.run).toHaveBeenCalled())
  expect(ai.createSession).toHaveBeenCalledTimes(1)
  const [sessionId] = ai.run.mock.calls[0]
  expect(sessionId).toBe('new-1')
  const text = sentText(ai.run.mock.calls[0])
  expect(text).toContain('conn.note.agentPrompt|')
  expect(text).toContain('web-01')
  expect(text).toContain('10.0.0.1:22')
  expect(useAiStore.getState().activeId).toBe('new-1')
  expect(onDismiss).toHaveBeenCalled()
  await waitFor(() => expect(useWorkspaceStore.getState().aiOpen).toBe(true))
  expect(useSessionStore.getState().tab).toEqual({ kind: 'connections' })
})

it('reuses an existing empty session instead of piling up new ones', async () => {
  useAiStore.setState({
    sessions: [
      {
        id: 'empty',
        title: '',
        createdAt: 1,
        updatedAt: 1,
        messages: [],
        status: 'ready',
        loaded: true
      }
    ],
    activeId: 'empty'
  })
  renderDialog(vi.fn())

  await waitFor(() => expect(ai.run).toHaveBeenCalled())
  expect(ai.createSession).not.toHaveBeenCalled()
  expect(ai.run.mock.calls[0][0]).toBe('empty')
  expect(sentText(ai.run.mock.calls[0])).toContain('web-01')
})
