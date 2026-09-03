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
