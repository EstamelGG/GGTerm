// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HumanInputCard } from '../src/renderer/src/pages/ai/HumanInputCard'
import { MessageItem } from '../src/renderer/src/pages/ai/MessageItem'
import { ChatComposer } from '../src/renderer/src/pages/ai/ChatComposer'
import { useAiStore } from '../src/renderer/src/stores/ai'
import type { AiUIMessage } from '../src/shared/types'
import type { HumanInputRequest } from '../src/shared/execution'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/components/ai/Markdown', () => ({
  Markdown: ({ children }: { children: string }) => <span>{children}</span>
}))
vi.mock('../src/renderer/src/components/ai/ExecutionSessionsButton', () => ({
  ExecutionSessionsButton: () => null
}))
const originalApproval = useAiStore.getState().respondApproval
afterEach(() => {
  cleanup()
  useAiStore.setState({ respondApproval: originalApproval })
})
it.each([false, true])('clears sensitive input after submission (failure=%s)', async (failed) => {
  const submit = failed
    ? vi.fn().mockRejectedValue(new Error('Submit failed'))
    : vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'aterm', { configurable: true, value: { humanInput: { submit } } })
  const request = {
    sessionId: 's',
    executionId: 'e',
    hostId: 'h',
    prompt: 'Password:'
  } as HumanInputRequest
  render(<HumanInputCard request={request} />)
  const input = screen.getByPlaceholderText('ai.inputPlaceholder') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'private-value' } })
  fireEvent.click(screen.getByText('ai.inputSubmit'))
  expect(submit).toHaveBeenCalledWith('s', 'e', 'private-value')
  await waitFor(() => expect(input.value).toBe(''))
  if (failed) expect(screen.getByText('Submit failed')).toBeTruthy()
})
it('preserves batch approval routing to the original session and approval IDs', () => {
  const respond = vi.fn()
  useAiStore.setState({ respondApproval: respond })
  const message = {
    id: 'm',
    role: 'assistant',
    parts: [1, 2, 3].map((id) => ({
      type: 'tool-execute',
      toolCallId: `call-${id}`,
      input: { command: 'pwd' },
      state: 'approval-requested',
      approval: { id: `approval-${id}` }
    }))
  } as AiUIMessage
  render(<MessageItem m={message} sessionId="session" />)
  fireEvent.click(screen.getByText('ai.approvalApproveAll'))
  expect(respond.mock.calls).toEqual([1, 2, 3].map((id) => ['session', `approval-${id}`, true]))
})
it('retains the composer draft across rerenders and clears it only on send', () => {
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: { executions: { list: vi.fn().mockResolvedValue([]) } }
  })
  const onSend = vi.fn()
  const props = {
    sessionId: 's',
    busy: false,
    disabled: false,
    placeholder: 'Draft',
    onSend,
    onCancel: vi.fn(),
    onViewApprovals: vi.fn()
  }
  const { rerender } = render(<ChatComposer {...props} />)
  const input = screen.getByPlaceholderText('Draft') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: 'Hello' } })
  rerender(<ChatComposer {...props} />)
  expect(input.value).toBe('Hello')
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onSend).toHaveBeenCalledWith('Hello')
  expect(input.value).toBe('')
})
