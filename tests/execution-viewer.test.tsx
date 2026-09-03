// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ExecutionSessionsDialog from '../src/renderer/src/components/ai/ExecutionSessionsDialog'
import { ExecutionSessionsButton } from '../src/renderer/src/components/ai/ExecutionSessionsButton'
import type { ExecutionSnapshot } from '../src/shared/execution'

const terminal = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  attachTerminal: vi.fn(),
  disposeTerminal: vi.fn(),
  fitTerminal: vi.fn(),
  refreshTerminalFonts: vi.fn(),
  writeTerminal: vi.fn()
}))
vi.mock('../src/renderer/src/terminal/registry', () => terminal)
vi.mock('../src/renderer/src/terminal/theme', () => ({ loadTerminalFonts: async () => {} }))
vi.mock('../src/renderer/src/lib/observeSettledResize', () => ({
  observeSettledResize: () => () => {}
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

let api: {
  list: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
}
const task = (id: string, sessionId: string): ExecutionSnapshot => ({
  executionId: id,
  sessionId,
  target: 'remote',
  hostId: 'host-1',
  command: `command-${id}`,
  status: 'running',
  output: '',
  cursor: 6,
  truncated: false,
  exitCode: null,
  needsInput: false,
  sensitiveInput: false,
  cancelRequested: false
})
beforeEach(() => {
  vi.clearAllMocks()
  api = {
    list: vi.fn(async (owner) => [task(`${owner}-task`, owner)]),
    read: vi.fn(async (owner, id) => ({
      ...task(id, owner),
      status: 'completed',
      output: 'hello\n'
    })),
    terminate: vi.fn(async () => {})
  }
  Object.defineProperty(window, 'aterm', { configurable: true, value: { executions: api } })
})
afterEach(cleanup)

it('does not poll or create terminals until the composer button is opened', async () => {
  render(<ExecutionSessionsButton sessionId="one" />)
  expect(api.list).not.toHaveBeenCalled()
  expect(terminal.createTerminal).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'execution.title' }))
  await screen.findByText('command-one-task', { selector: 'button span' })
  expect(api.list).toHaveBeenCalledWith('one')
})

it('uses a read-only terminal, scopes requests to the conversation, and closing the view never terminates', async () => {
  const onClose = vi.fn()
  const view = render(<ExecutionSessionsDialog sessionId="one" onClose={onClose} />)
  await waitFor(() => expect(terminal.writeTerminal).toHaveBeenCalled())
  expect(terminal.createTerminal).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ readOnly: true })
  )
  expect(api.read).toHaveBeenCalledWith('one', 'one-task', 0)
  expect(window.aterm.executions).not.toHaveProperty('input')
  expect(window.aterm.executions).not.toHaveProperty('resize')
  fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
  expect(onClose).toHaveBeenCalledOnce()
  view.unmount()
  expect(terminal.disposeTerminal).toHaveBeenCalled()
  expect(api.terminate).not.toHaveBeenCalled()
  render(<ExecutionSessionsDialog sessionId="two" onClose={onClose} />)
  await screen.findByText('command-two-task', { selector: 'button span' })
  expect(screen.queryByText('command-one-task')).toBeNull()
  expect(api.list).toHaveBeenLastCalledWith('two')
})

it('requires explicit confirmation to terminate and leaves the record visible', async () => {
  render(<ExecutionSessionsDialog sessionId="one" onClose={() => {}} />)
  await screen.findByText('command-one-task', { selector: 'button span' })
  fireEvent.click(screen.getByRole('button', { name: 'execution.terminate' }))
  expect(api.terminate).not.toHaveBeenCalled()
  const confirmation = screen.getAllByRole('dialog').at(-1)!
  fireEvent.click(within(confirmation).getByRole('button', { name: 'execution.terminate' }))
  await waitFor(() => expect(api.terminate).toHaveBeenCalledWith('one', 'one-task'))
  await screen.findByText(/execution.terminationRequested/)
  expect(screen.getByText('command-one-task', { selector: 'button span' })).toBeTruthy()
})
