// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ActivityRail } from '../src/renderer/src/components/activity/ActivityRail'
import { useWorkspaceStore } from '../src/renderer/src/stores/workspace'
import { useSessionStore, type HostWorkspaceMirror } from '../src/renderer/src/stores/session'
import { useSftpStore, type SftpPaneState } from '../src/renderer/src/stores/sftp'
import { useConnectionsStore } from '../src/renderer/src/stores/connections'
import { useCommandsStore } from '../src/renderer/src/stores/commands'
import { usePortForwardsStore } from '../src/renderer/src/stores/portForwards'
import type { HostConnection, SftpTransferMirror } from '../src/shared/types'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/pages/AiWorkspacePage', () => ({
  default: () => <input aria-label="AI draft" />
}))
vi.mock('../src/renderer/src/components/activity/panels/PerformancePanel', () => ({
  PerformancePanel: ({ hostId }: { hostId: string }) => <div>performance:{hostId}</div>
}))

const watch = vi.fn()
const input = vi.fn()
const cancel = vi.fn()
const stop = vi.fn()
const host = (id: string): HostWorkspaceMirror => ({
  id,
  title: `Host ${id}`,
  conn: { id, name: `Host ${id}`, host: id, port: 22, username: 'test' } as HostConnection,
  phase: 'connected',
  attempt: 0,
  offlineReason: '',
  awaiting: false,
  pendingSecrets: null,
  shells: [{ id: `shell-${id}`, number: 1, status: 'connected' }],
  focusShellId: `shell-${id}`,
  files: [],
  focusFileId: null
})
const transfer = (status: SftpTransferMirror['status']): SftpTransferMirror => ({
  id: 'same-id',
  name: 'file.txt',
  direction: 'down',
  bytes: 10,
  total: 100,
  status
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      perf: { watchSession: watch },
      shells: { input },
      sftp: { cancelTransfer: cancel, stop, revealDownloads: vi.fn() },
      portForwards: {
        list: vi.fn(async () => []),
        onChanged: vi.fn(() => () => {}),
        configure: vi.fn(),
        control: vi.fn(),
        probe: vi.fn()
      }
    }
  })
  useWorkspaceStore.setState({
    sidebarOpen: true,
    activePanel: 'ai',
    focusedHostId: null,
    attachments: {}
  })
  useSessionStore.setState({ hosts: [host('a'), host('b')], tab: { kind: 'connections' } })
  useConnectionsStore.setState({ connections: [host('a').conn, host('b').conn] })
  useCommandsStore.setState({ commands: [{ id: 'cmd', name: 'List files', command: 'ls' }] })
  useSftpStore.setState({ panes: {} })
  usePortForwardsStore.setState({ rules: [], filterHostId: '', editor: null })
})
afterEach(cleanup)

it('starts a tunnel through its background service without opening a host workspace', async () => {
  useSessionStore.setState({ hosts: [], tab: { kind: 'connections' } })
  render(<ActivityRail />)
  await screen.findByLabelText('AI draft')
  act(() => {
    usePortForwardsStore.setState({
      rules: [
        {
          id: 'tunnel',
          name: 'Database tunnel',
          hostId: 'a',
          type: 'local',
          listenAddress: '127.0.0.1',
          listenPort: 13306,
          targetHost: '127.0.0.1',
          targetPort: 3306,
          startPolicy: 'manual',
          owner: 'user',
          status: 'stopped',
          connections: 0,
          bytesUp: 0,
          bytesDown: 0,
          error: null
        }
      ]
    })
    usePortForwardsStore.getState().open()
  })
  fireEvent.click(screen.getByRole('button', { name: 'forward.start' }))
  await vi.waitFor(() =>
    expect(window.aterm.portForwards.control).toHaveBeenCalledWith('tunnel', 'start')
  )
  expect(useSessionStore.getState().hosts).toEqual([])
  expect(useSessionStore.getState().tab).toEqual({ kind: 'connections' })
})

it('opens port forwarding globally without a shell and preselects a host for creating a rule', async () => {
  render(<ActivityRail />)
  fireEvent.click(screen.getByRole('button', { name: 'forward.title' }))
  expect(screen.getByText('forward.empty')).toBeTruthy()
  expect(screen.queryByText('activity.noFocusedHost')).toBeNull()
  act(() => usePortForwardsStore.getState().open('b', true))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('Host b · b')).toBeTruthy()
  expect(useWorkspaceStore.getState()).toMatchObject({ activePanel: 'forwards', sidebarOpen: true })
  const rule = {
    ...host('b').conn,
    name: 'Preview',
    hostId: 'b',
    type: 'local',
    listenAddress: '127.0.0.1',
    listenPort: 8080,
    targetHost: '127.0.0.1',
    targetPort: 80,
    startPolicy: 'manual'
  }
  vi.mocked(window.aterm.portForwards.configure).mockResolvedValue(rule as never)
  fireEvent.click(within(dialog).getByRole('button', { name: 'common.save' }))
  await vi.waitFor(() =>
    expect(window.aterm.portForwards.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: 'b',
        type: 'local',
        listenAddress: '127.0.0.1',
        startPolicy: 'manual'
      }),
      undefined
    )
  )
  expect(window.aterm.portForwards.control).not.toHaveBeenCalled()
})

it('keeps AI mounted when switching and collapsing, and host references reopen AI', async () => {
  render(<ActivityRail />)
  const draft = await screen.findByLabelText('AI draft')
  fireEvent.change(draft, { target: { value: 'unfinished question' } })
  fireEvent.click(screen.getByRole('button', { name: 'activity.transfers' }))
  expect(screen.getByText('activity.transfersEmpty')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'activity.transfers' }))
  expect(useWorkspaceStore.getState().sidebarOpen).toBe(false)
  act(() => useWorkspaceStore.getState().attachHost('chat', 'b'))
  expect(useWorkspaceStore.getState().activePanel).toBe('ai')
  expect(useWorkspaceStore.getState().sidebarOpen).toBe(true)
  expect((screen.getByLabelText('AI draft') as HTMLInputElement).value).toBe('unfinished question')
})

it('requires a shell host, follows it for performance and commands, and stops targeting it on close', () => {
  render(<ActivityRail />)
  fireEvent.click(screen.getByRole('button', { name: 'activity.performance' }))
  expect(screen.getByText('activity.noFocusedHost')).toBeTruthy()
  act(() => useSessionStore.getState().setTab({ kind: 'host', id: 'a' }))
  expect(screen.getByText('performance:a')).toBeTruthy()
  expect(watch).toHaveBeenLastCalledWith('a')
  fireEvent.click(screen.getByRole('button', { name: 'activity.commands' }))
  fireEvent.click(screen.getByRole('button', { name: 'activity.commandsRun' }))
  expect(input).toHaveBeenLastCalledWith('a', 'shell-a', 'ls\n')
  act(() => useSessionStore.getState().setTab({ kind: 'host', id: 'b' }))
  fireEvent.click(screen.getByRole('button', { name: 'activity.commandsRun' }))
  expect(input).toHaveBeenLastCalledWith('b', 'shell-b', 'ls\n')
  act(() => useWorkspaceStore.getState().focusHost(null))
  expect(screen.getByText('activity.noFocusedHost')).toBeTruthy()
  expect(watch).toHaveBeenLastCalledWith(null)
})

it('aggregates hosts with distinct cancel targets and clears finished transfers globally', () => {
  useSftpStore.setState({
    panes: {
      a: { started: true, transfers: [transfer('running')] } as SftpPaneState,
      b: {
        started: true,
        transfers: [transfer('running'), { ...transfer('done'), id: 'done' }]
      } as SftpPaneState
    }
  })
  useWorkspaceStore.setState({ activePanel: 'transfers' })
  render(<ActivityRail />)
  fireEvent.click(
    within(screen.getByText('Host a').parentElement!).getByRole('button', { name: 'common.cancel' })
  )
  expect(cancel).toHaveBeenLastCalledWith('a', 'same-id')
  fireEvent.click(
    within(screen.getAllByText('Host b')[0].parentElement!).getByRole('button', {
      name: 'common.cancel'
    })
  )
  expect(cancel).toHaveBeenLastCalledWith('b', 'same-id')
  fireEvent.click(screen.getByRole('button', { name: 'activity.transfersClear' }))
  expect(useSftpStore.getState().panes.b.transfers.map((tr) => tr.id)).toEqual(['same-id'])
  expect(useSftpStore.getState().panes.a.transfers).toHaveLength(1)
})

it('keeps transfer history after closing the host and accepts its final cancellation event', () => {
  useSftpStore.setState({
    panes: { a: { started: true, transfers: [transfer('running')] } as SftpPaneState }
  })
  useSftpStore.getState().dropHost('a')
  expect(stop).toHaveBeenCalledWith('a')
  expect(useSftpStore.getState().panes.a.started).toBe(false)
  useSftpStore.getState().applyTransferEvent({ hostId: 'a', transfer: transfer('canceled') })
  expect(useSftpStore.getState().panes.a.transfers[0].status).toBe('canceled')
  useSftpStore.getState().clearFinished()
  expect(useSftpStore.getState().panes.a.transfers).toEqual([])
})
