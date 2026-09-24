// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ExecutionOutput } from '../src/renderer/src/components/ai/ExecutionOutput'
import { useExecutionTabs } from '../src/renderer/src/stores/executionTabs'
import { useSessionStore } from '../src/renderer/src/stores/session'
import { useConnectionsStore } from '../src/renderer/src/stores/connections'
import type { HostConnection } from '../src/shared/types'
import { HostSessionPage } from '../src/renderer/src/pages/HostSessionPage'
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
vi.mock('../src/renderer/src/components/chrome/SessionTabs', () => ({
  SessionTabs: ({
    tabs,
    onClose
  }: {
    tabs: { id: string; title: string }[]
    onClose: (id: string) => void
  }) => (
    <>
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onClose(t.id)}>
          {t.title}
        </button>
      ))}
    </>
  )
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
  useExecutionTabs.setState({ tasks: [], dismissed: [] })
  useSessionStore.setState({ hosts: [], tab: { kind: 'ai' } })
  useConnectionsStore.setState({
    connections: [
      {
        id: 'host-1',
        name: 'Switch',
        username: 'admin',
        host: 'switch',
        port: 22,
        keepaliveInterval: 5000
      } as HostConnection
    ]
  })
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

it('opens agent output in the host workspace without a user SSH transport or modal', async () => {
  render(<ExecutionSessionsButton sessionId="one" />)
  fireEvent.click(screen.getByRole('button', { name: 'execution.title' }))
  await waitFor(() =>
    expect(useSessionStore.getState().tab).toEqual({ kind: 'host', id: 'host-1' })
  )
  expect(useSessionStore.getState().hosts[0]).toMatchObject({
    viewerOnly: true,
    shells: [],
    focusShellId: 'one-task'
  })
  expect(useExecutionTabs.getState().tasks[0].sessionId).toBe('one')
  expect(screen.queryByRole('dialog')).toBeNull()
})
it('keeps terminal output read-only and changing views never terminates the shell', async () => {
  const view = render(<ExecutionOutput task={task('one-task', 'one')} />)
  await waitFor(() => expect(terminal.writeTerminal).toHaveBeenCalled())
  expect(terminal.createTerminal).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ readOnly: true })
  )
  expect(api.read).toHaveBeenCalledWith('one', 'one-task', 0)
  expect(window.aterm.executions).not.toHaveProperty('input')
  expect(window.aterm.executions).not.toHaveProperty('resize')
  view.unmount()
  expect(terminal.disposeTerminal).toHaveBeenCalled()
  expect(api.terminate).not.toHaveBeenCalled()
})
it('closes only the selected agent shell and does not reopen it on the next poll', async () => {
  const first = task('first', 'one'),
    second = task('second', 'two')
  useExecutionTabs.getState().sync([first, second], true)
  await useExecutionTabs.getState().close(first)
  expect(api.terminate).toHaveBeenCalledWith('one', 'first')
  useExecutionTabs.getState().sync([first, second])
  expect(useExecutionTabs.getState().tasks.map((t) => t.executionId)).toEqual(['second'])
})
it('retains the tab if termination fails', async () => {
  const first = task('first', 'one')
  useExecutionTabs.getState().sync([first])
  api.terminate.mockRejectedValueOnce(new Error('failed'))
  await expect(useExecutionTabs.getState().close(first)).rejects.toThrow('failed')
  expect(useExecutionTabs.getState().tasks).toHaveLength(1)
})
it('does not recreate a detached workspace from a repeated snapshot', () => {
  const first = task('first', 'one')
  useExecutionTabs.getState().sync([first])
  useSessionStore.setState({ hosts: [] })
  useExecutionTabs.getState().sync([first])
  expect(useSessionStore.getState().hosts).toEqual([])
  useExecutionTabs.getState().sync([first], true)
  expect(useSessionStore.getState().hosts).toHaveLength(1)
})

it('closing an agent tab requires confirmation, and cancelling keeps the shell alive', async () => {
  const first = task('first', 'one')
  useExecutionTabs.getState().sync([first], true)
  render(
    <HostSessionPage
      host={useSessionStore.getState().hosts[0]}
      onClose={() => {}}
      onToast={() => {}}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'agent one · first' }))
  expect(screen.getByText('execution.closeTabConfirm')).toBeTruthy()
  expect(api.terminate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
  expect(api.terminate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'agent one · first' }))
  const confirm = screen
    .getAllByRole('button', { name: 'common.close' })
    .find((b) => !b.hasAttribute('data-slot'))!
  fireEvent.click(confirm)
  await waitFor(() => expect(api.terminate).toHaveBeenCalledWith('one', 'first'))
})
