// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { QuestionCard } from '../src/renderer/src/components/ai/QuestionCard'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)
const request = {
  sessionId: 's',
  toolCallId: 'q',
  question: '选择目标',
  options: [{ label: '检查' }, { label: '修复' }, { label: '监控' }]
}
it('renders three options plus Other without submitting a preselection', async () => {
  const answer = vi.fn(async () => {})
  Object.assign(window, { aterm: { questions: { answer } } })
  render(<QuestionCard request={request} />)
  expect(screen.getAllByRole('radio')).toHaveLength(4)
  expect((screen.getByText('ai.inputSubmit') as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByText('修复'))
  expect(answer).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('ai.inputSubmit'))
  await waitFor(() => expect(answer).toHaveBeenCalledWith('s', 'q', 1, ''))
})
it('requires nonempty Other input and reports a failed submission for retry', async () => {
  const answer = vi.fn().mockRejectedValueOnce(new Error('retry')).mockResolvedValue(undefined)
  Object.assign(window, { aterm: { questions: { answer } } })
  render(<QuestionCard request={request} />)
  fireEvent.click(screen.getByText('ai.questionOther'))
  expect((screen.getByText('ai.inputSubmit') as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '查看下载进度' } })
  fireEvent.click(screen.getByText('ai.inputSubmit'))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByText('ai.inputSubmit'))
  await waitFor(() => expect(answer).toHaveBeenCalledTimes(2))
  expect(answer).toHaveBeenLastCalledWith('s', 'q', null, '查看下载进度')
})
