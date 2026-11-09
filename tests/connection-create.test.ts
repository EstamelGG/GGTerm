// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { useConnectionsStore } from '../src/renderer/src/stores/connections'
import type { HostConnection, HostGroup } from '../src/shared/types'

afterEach(() => useConnectionsStore.setState({ connections: [], groups: [], loaded: false }))
it('does not duplicate a connection already delivered by the change broadcast', async () => {
  const conn = { id: 'host', name: 'Server', host: 'localhost', username: 'user' } as HostConnection
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      connections: {
        create: vi.fn(async () => {
          useConnectionsStore.setState({ connections: [conn] })
          return conn
        })
      },
      secrets: { save: vi.fn(async () => {}) }
    }
  })
  await useConnectionsStore.getState().create(conn, {})
  expect(window.aterm.connections.create).toHaveBeenCalledWith(conn, {})
  expect(window.aterm.secrets.save).not.toHaveBeenCalled()
  expect(useConnectionsStore.getState().connections).toEqual([conn])
})

it('submits metadata and credentials in one update and preserves the mirror on failure', async () => {
  const conn = { id: 'host', name: 'Before' } as HostConnection
  const update = vi.fn().mockRejectedValue(new Error('save failed'))
  const save = vi.fn()
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      connections: { update },
      secrets: { save }
    }
  })
  useConnectionsStore.setState({ connections: [conn] })
  await expect(
    useConnectionsStore.getState().update('host', { name: 'After' }, { password: 'new' })
  ).rejects.toThrow('save failed')
  expect(update).toHaveBeenCalledExactlyOnceWith('host', { name: 'After' }, { password: 'new' })
  expect(save).not.toHaveBeenCalled()
  expect(useConnectionsStore.getState().connections).toEqual([conn])
})
it('does not duplicate a group already delivered by the change broadcast', async () => {
  const group = { id: 'group', name: 'Group' } as HostGroup
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      groups: {
        create: vi.fn(async () => {
          useConnectionsStore.setState({ groups: [group] })
          return group
        })
      }
    }
  })
  await useConnectionsStore.getState().createGroup(group)
  expect(useConnectionsStore.getState().groups).toEqual([group])
})
