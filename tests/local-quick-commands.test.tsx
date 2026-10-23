// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ActivityRail } from '../src/renderer/src/components/activity/ActivityRail'
import { useWorkspaceStore } from '../src/renderer/src/stores/workspace'
import { useSessionStore, type HostWorkspaceMirror } from '../src/renderer/src/stores/session'
import { useLocalTerminalStore } from '../src/renderer/src/stores/localTerminal'
import { useCommandsStore } from '../src/renderer/src/stores/commands'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/pages/AiWorkspacePage', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/activity/panels/HostResourcesPanel', () => ({
  HostResourcesPanel: () => null
}))

const input = vi.fn()
const write = vi.fn(async () => {})
beforeEach(() => {
  vi.clearAllMocks()
  write.mockResolvedValue(undefined)
  Object.assign(window, {
    aterm: {
      shells: { input },
      localTerminal: { write },
      portForwards: { onChanged: () => () => {}, list: async () => [] }
    }
  })
  useWorkspaceStore.setState({
    sidebarOpen: true,
    activePanel: 'commands',
    focusedHostId: 'remote',
    terminalTarget: 'host'
  })
  useSessionStore.setState({
    tab: { kind: 'host', id: 'remote' },
    hosts: [
      {
        id: 'remote',
        title: 'Remote host',
        phase: 'connected',
        conn: { username: 'user', host: 'server', port: 22 },
        shells: [{ id: 'ssh-shell', number: 1, status: 'connected' }],
        focusShellId: 'ssh-shell'
      } as HostWorkspaceMirror
    ]
  })
  useLocalTerminalStore.setState({
    tabs: [
      { id: 'one', number: 1, shell: 'sh', cwd: '/home/test' },
      { id: 'two', number: 2, shell: 'sh', cwd: '/home/test' }
    ],
    activeId: 'one',
    creating: false
  })
  useCommandsStore.setState({
    commands: [{ id: 'quick', name: 'Quick command', command: 'echo hello' }]
  })
})
afterEach(cleanup)

it('follows the active local tab, retains it on settings, and switches back to SSH explicitly', () => {
  useSessionStore.getState().setTab({ kind: 'local' })
  render(<ActivityRail />)
  expect(screen.getByText('localTerminal.tab 1')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'activity.commandsRun' }))
  expect(write).toHaveBeenLastCalledWith('one', 'echo hello\r')
  expect(input).not.toHaveBeenCalled()
  act(() => {
    useLocalTerminalStore.getState().select('two')
    useSessionStore.getState().setTab({ kind: 'settings' })
  })
  expect(screen.getByText('localTerminal.tab 2')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'activity.commandsRun' }))
  expect(write).toHaveBeenLastCalledWith('two', 'echo hello\r')
  act(() => useSessionStore.getState().setTab({ kind: 'host', id: 'remote' }))
  expect(screen.getByText('Remote host')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'activity.commandsRun' }))
  expect(input).toHaveBeenLastCalledWith('remote', 'ssh-shell', 'echo hello\n')
})

it('does not fall back to a remote host after the local terminal exits or is closed', () => {
  useSessionStore.getState().setTab({ kind: 'local' })
  useLocalTerminalStore.setState({
    tabs: [{ id: 'one', number: 1, shell: 'sh', cwd: '/', exitCode: 0 }]
  })
  render(<ActivityRail />)
  const send = screen.getByRole('button', {
    name: 'activity.commandsNoTarget'
  }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  fireEvent.click(send)
  act(() => useLocalTerminalStore.setState({ tabs: [], activeId: null }))
  expect(
    (screen.getByRole('button', { name: 'activity.commandsNoTarget' }) as HTMLButtonElement)
      .disabled
  ).toBe(true)
  expect(input).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
  expect(screen.getByText('Quick command')).toBeTruthy()
})

it('normalizes local Enter sequences without appending a second Enter', () => {
  useSessionStore.getState().setTab({ kind: 'local' })
  useCommandsStore.setState({
    commands: [{ id: 'quick', name: 'Quick command', command: 'echo one\r\necho two\n' }]
  })
  render(<ActivityRail />)
  fireEvent.click(screen.getByRole('button', { name: 'activity.commandsRun' }))
  expect(write).toHaveBeenCalledExactlyOnceWith('one', 'echo one\recho two\r')
})

it('reports a failed local write and hides it when selecting another terminal', async () => {
  useSessionStore.getState().setTab({ kind: 'local' })
  write.mockRejectedValueOnce(new Error('Local terminal not found'))
  render(<ActivityRail />)
  fireEvent.click(screen.getByRole('button', { name: 'activity.commandsRun' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Local terminal not found')
  act(() => useLocalTerminalStore.getState().select('two'))
  expect(screen.queryByRole('alert')).toBeNull()
})
