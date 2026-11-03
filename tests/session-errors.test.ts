// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { useSessionStore, type HostWorkspaceMirror } from '../src/renderer/src/stores/session'
import { useConnectionsStore } from '../src/renderer/src/stores/connections'
import { useWorkspaceIssues } from '../src/renderer/src/stores/workspaceIssues'
afterEach(() => {
  vi.restoreAllMocks()
  useSessionStore.setState({ hosts: [] })
  useWorkspaceIssues.setState({ issues: {} })
})
it('reports credential persistence failure once and retries without re-authenticating', async () => {
  const update = vi
    .spyOn(useConnectionsStore.getState(), 'update')
    .mockRejectedValueOnce(new Error('Disk full'))
    .mockResolvedValueOnce(null)
  useSessionStore.setState({
    hosts: [
      {
        id: 'host',
        conn: { username: 'user', authType: 'manual' },
        pendingSecrets: { authType: 'password', password: 'test-secret' },
        shells: [],
        files: []
      } as unknown as HostWorkspaceMirror
    ]
  })
  useSessionStore.getState().applyHostState({ hostId: 'host', phase: 'connected', since: 1 })
  useSessionStore.getState().applyHostState({ hostId: 'host', phase: 'connected', since: 2 })
  await vi.waitFor(() =>
    expect(useWorkspaceIssues.getState().issues['credentials:host']?.message).toBe('Disk full')
  )
  expect(update).toHaveBeenCalledOnce()
  await useWorkspaceIssues.getState().retry('credentials:host')
  expect(update).toHaveBeenCalledTimes(2)
  expect(useWorkspaceIssues.getState().issues['credentials:host']).toBeUndefined()
})
