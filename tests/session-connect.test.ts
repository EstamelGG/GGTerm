// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { useSessionStore } from '../src/renderer/src/stores/session'
import type { HostConnection } from '../src/shared/types'

const originalAddShell = useSessionStore.getState().addShell

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
