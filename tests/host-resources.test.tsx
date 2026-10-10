// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HostResourcesPanel } from '../src/renderer/src/components/activity/panels/HostResourcesPanel'
import { useConnectionsStore } from '../src/renderer/src/stores/connections'
import { useSessionStore } from '../src/renderer/src/stores/session'
import { useAiStore } from '../src/renderer/src/stores/ai'
import { useWorkspaceStore } from '../src/renderer/src/stores/workspace'
import type { HostConnection } from '../src/shared/types'
import type { HostWorkspaceMirror } from '../src/renderer/src/stores/session'
import { resourceHostId } from '../src/renderer/src/lib/resourceHost'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/components/activity/panels/PerformancePanel', () => ({
  PerformancePanel: ({ hostId }: { hostId: string }) => <div>performance:{hostId}</div>
}))
const host = {
  id: 'agent-host',
  name: 'Agent host',
  host: 'localhost',
  username: 'test'
} as HostConnection
const connect = vi.fn(async () => {})
const watch = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  useConnectionsStore.setState({ connections: [host] })
  useSessionStore.setState({ hosts: [], connect })
  useAiStore.setState({ activeId: 'chat' })
  useWorkspaceStore.setState({ focusedHostId: null })
  Object.assign(window, {
    aterm: {
      hosts: {
        onAgentState: () => () => {},
        listAgentLinks: async () => [
          {
            hostId: host.id,
            sessionId: 'chat',
            connectionId: 'agent-transport',
            phase: 'connected'
          }
        ]
      },
      perf: { watchSession: watch }
    }
  })
})
afterEach(cleanup)

it('connects the current Agent host for performance monitoring without requesting a terminal', async () => {
  const view = render(<HostResourcesPanel visible />)
  await waitFor(() => expect(connect).toHaveBeenCalledWith(host, false))
  useSessionStore.setState({
    hosts: [
      { id: host.id, conn: host, phase: 'connected', shells: [] } as unknown as HostWorkspaceMirror
    ]
  })
  await screen.findByText('performance:agent-host')
  expect(watch).toHaveBeenCalledWith(host.id)
  expect(useWorkspaceStore.getState().focusedHostId).toBeNull()
  view.unmount()
})

it('starts performance sampling after a user connection becomes ready and stops when hidden', async () => {
  const view = render(<HostResourcesPanel visible />)
  await waitFor(() => expect(connect).toHaveBeenCalledWith(host, false))
  expect(watch).not.toHaveBeenCalled()
  useSessionStore.setState({
    hosts: [{ id: host.id, conn: host, phase: 'connected' } as unknown as HostWorkspaceMirror]
  })
  await waitFor(() => expect(watch).toHaveBeenCalledWith(host.id))
  view.rerender(<HostResourcesPanel visible={false} />)
  expect(watch).toHaveBeenLastCalledWith(null)
})

it('follows the focused host before Agent context and ignores deleted hosts', () => {
  const hosts = [{ id: 'agent' }, { id: 'terminal' }]
  const links = [{ hostId: 'agent', sessionId: 'chat', phase: 'connected' as const }]
  expect(resourceHostId(hosts, links, 'chat', 'terminal')).toBe('terminal')
  expect(resourceHostId(hosts, links, 'chat', 'deleted')).toBe('agent')
  expect(resourceHostId(hosts, links, 'different-chat', 'terminal')).toBe('terminal')
  expect(resourceHostId(hosts, [], 'chat', null)).toBeNull()
})
