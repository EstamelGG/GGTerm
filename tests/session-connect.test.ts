// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { useSessionStore } from '../src/renderer/src/stores/session'
import type { HostConnection } from '../src/shared/types'

const originalAddShell = useSessionStore.getState().addShell
vi.mock('../src/renderer/src/terminal/registry', () => ({ disposeTerminal: vi.fn() }))
vi.mock('../src/renderer/src/stores/sftp', () => ({
  useSftpStore: { getState: () => ({ dropHost: vi.fn() }) }
}))

afterEach(() => {
  useSessionStore.setState({ hosts: [], addShell: originalAddShell, tab: { kind: 'connections' } })
})

it('keeps one workspace when two connection replies arrive for the same host', async () => {
  const replies: Array<(result: { awaiting: boolean }) => void> = []
  const connect = vi.fn(
    () => new Promise<{ awaiting: boolean }>((resolve) => replies.push(resolve))
  )
  Object.defineProperty(window, 'aterm', { configurable: true, value: { hosts: { connect } } })
  const addShell = vi.fn()
  useSessionStore.setState({ hosts: [], addShell })
  const conn = { id: 'race-host', name: 'Server' } as HostConnection
  const first = useSessionStore.getState().connect(conn)
  const second = useSessionStore.getState().connect(conn)
  replies[1]({ awaiting: false })
  await second
  replies[0]({ awaiting: false })
  await first
  expect(useSessionStore.getState().hosts.map((h) => h.id)).toEqual(['race-host'])
  expect(addShell).toHaveBeenCalledTimes(2)
  expect(useSessionStore.getState().tab).toEqual({ kind: 'host', id: 'race-host' })
})

it('does not resurrect a detached workspace when its connection reply arrives', async () => {
  let reply!: (value: { awaiting: boolean }) => void
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      hosts: {
        connect: () =>
          new Promise((resolve) => {
            reply = resolve
          })
      }
    }
  })
  const addShell = vi.fn()
  useSessionStore.setState({ addShell })
  const pending = useSessionStore
    .getState()
    .connect({ id: 'closed', name: 'Closed' } as HostConnection)
  useSessionStore.getState().detachHost('closed')
  reply({ awaiting: false })
  await pending
  expect(useSessionStore.getState().hosts).toEqual([])
  expect(addShell).not.toHaveBeenCalled()
})

it('finishes a requested connection without taking focus back after navigation', async () => {
  let reply!: (value: { awaiting: boolean }) => void
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      hosts: {
        connect: () =>
          new Promise((resolve) => {
            reply = resolve
          })
      }
    }
  })
  useSessionStore.setState({ addShell: vi.fn() })
  const pending = useSessionStore.getState().connect({ id: 'slow', name: 'Slow' } as HostConnection)
  useSessionStore.getState().setTab({ kind: 'settings' })
  reply({ awaiting: false })
  await pending
  expect(useSessionStore.getState().hosts[0].id).toBe('slow')
  expect(useSessionStore.getState().tab).toEqual({ kind: 'settings' })
})

it('keeps the most recently requested host as the navigation target', async () => {
  const replies: ((value: { awaiting: boolean }) => void)[] = []
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      hosts: {
        connect: () => new Promise((resolve) => replies.push(resolve))
      }
    }
  })
  useSessionStore.setState({ addShell: vi.fn() })
  const first = useSessionStore.getState().connect({ id: 'first', name: 'First' } as HostConnection)
  const last = useSessionStore.getState().connect({ id: 'last', name: 'Last' } as HostConnection)
  replies[0]({ awaiting: false })
  await first
  expect(useSessionStore.getState().tab).toEqual({ kind: 'connections' })
  replies[1]({ awaiting: false })
  await last
  expect(useSessionStore.getState().tab).toEqual({ kind: 'host', id: 'last' })
})

it('restores one viewer using current connection state without opening a user transport', async () => {
  const { useLinksStore } = await import('../src/renderer/src/stores/links')
  useLinksStore.setState({ byHost: { viewer: { hostId: 'viewer', phase: 'connected', since: 1 } } })
  const connect = vi.fn()
  Object.defineProperty(window, 'aterm', { configurable: true, value: { hosts: { connect } } })
  const conn = { id: 'viewer', name: 'Viewer' } as HostConnection
  useSessionStore.getState().restoreViewer(conn, 'task')
  useSessionStore.getState().restoreViewer(conn, 'task')
  expect(useSessionStore.getState().hosts).toHaveLength(1)
  expect(useSessionStore.getState().hosts[0]).toMatchObject({
    phase: 'connected',
    viewerOnly: true,
    focusShellId: 'task'
  })
  expect(connect).not.toHaveBeenCalled()
})

it('connects without creating a shell or changing the current page, then enters on request', async () => {
  const connect = vi.fn(async () => ({ awaiting: false }))
  Object.defineProperty(window, 'aterm', { configurable: true, value: { hosts: { connect } } })
  const addShell = vi.fn()
  useSessionStore.setState({ hosts: [], addShell, tab: { kind: 'ai' } })
  const conn = { id: 'background-host', name: 'Server' } as HostConnection
  await useSessionStore.getState().connect(conn, false)
  await useSessionStore.getState().connect(conn, false)
  expect(connect).toHaveBeenCalledTimes(1)
  expect(addShell).not.toHaveBeenCalled()
  expect(useSessionStore.getState().tab).toEqual({ kind: 'ai' })
  expect(useSessionStore.getState().hosts[0].shells).toEqual([])
  await useSessionStore.getState().connect(conn)
  expect(addShell).toHaveBeenCalledTimes(1)
  expect(useSessionStore.getState().tab).toEqual({ kind: 'host', id: conn.id })
})

it('retains manual authentication state for connect-only without entering a session', async () => {
  const connect = vi.fn(async () => ({ awaiting: true }))
  Object.defineProperty(window, 'aterm', { configurable: true, value: { hosts: { connect } } })
  const addShell = vi.fn()
  useSessionStore.setState({ hosts: [], addShell, tab: { kind: 'connections' } })
  await useSessionStore
    .getState()
    .connect({ id: 'manual', name: 'Manual' } as HostConnection, false)
  expect(useSessionStore.getState().hosts[0].awaiting).toBe(true)
  expect(addShell).not.toHaveBeenCalled()
  expect(useSessionStore.getState().tab).toEqual({ kind: 'connections' })
})

it('keeps the entered shell host as AI context when connecting to another host in the background', async () => {
  const { useWorkspaceStore } = await import('../src/renderer/src/stores/workspace')
  const connect = vi.fn(async () => ({ awaiting: false }))
  Object.defineProperty(window, 'aterm', { configurable: true, value: { hosts: { connect } } })
  useSessionStore.setState({ hosts: [], addShell: vi.fn() })
  await useSessionStore.getState().connect({ id: 'shell-host', name: 'Shell' } as HostConnection)
  await useSessionStore
    .getState()
    .connect({ id: 'background', name: 'Background' } as HostConnection, false)
  useWorkspaceStore.getState().attachHost('chat', 'background')
  expect(useWorkspaceStore.getState().focusedHostId).toBe('shell-host')
  expect(useSessionStore.getState().tab).toEqual({ kind: 'host', id: 'shell-host' })
  useSessionStore.getState().setTab({ kind: 'connections' })
  expect(useWorkspaceStore.getState().focusedHostId).toBe('shell-host')
  await useSessionStore
    .getState()
    .connect({ id: 'background', name: 'Background' } as HostConnection)
  expect(useWorkspaceStore.getState().focusedHostId).toBe('background')
})

it('creates a viewer workspace for an Agent connection without opening a shell or replacing focus', async () => {
  const connect = vi.fn(async () => ({ awaiting: false, viewerOnly: true, phase: 'connected' }))
  Object.defineProperty(window, 'aterm', { configurable: true, value: { hosts: { connect } } })
  const addShell = vi.fn()
  useSessionStore.setState({ hosts: [], addShell, tab: { kind: 'ai' } })
  const conn = { id: 'agent-viewer', name: 'Server' } as HostConnection
  await useSessionStore.getState().connect(conn, false)
  expect(connect).toHaveBeenCalledWith(conn, true)
  expect(useSessionStore.getState().hosts[0]).toMatchObject({
    viewerOnly: true,
    phase: 'connected',
    shells: []
  })
  expect(useSessionStore.getState().tab).toEqual({ kind: 'ai' })
  expect(addShell).not.toHaveBeenCalled()
})
