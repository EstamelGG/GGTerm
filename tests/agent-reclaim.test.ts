import { expect, it, vi } from 'vitest'
import type { HostConnection } from '../src/shared/types'

const fixture = vi.hoisted(() => ({ idle: undefined as (() => void) | undefined, nextId: 0 }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/main/ssh/link', () => ({
  getLink: vi.fn(),
  removeLink: vi.fn(),
  HostLink: class {
    connectionId = String(++fixture.nextId)
    phase = 'connected'
    shutdown = vi.fn()
    update = vi.fn()
    constructor(public hostId: string) {}
  }
}))
vi.mock('../src/main/ai/exec', () => ({
  executions: {
    list: () => [{ hostId: 'host', status: 'running' }],
    closeHost: vi.fn(),
    onSessionIdle: (_session: string, callback: () => void) => {
      fixture.idle = callback
    }
  }
}))
const api = await import('../src/main/ai/agentLinks')
it('does not close a replacement connection when deferred session reclamation finally runs', () => {
  api.agentConnectionContext.run('chat', () => {
    const host = { id: 'host' } as HostConnection
    const old = api.getOrCreateAgentLink(host)
    api.reclaimAgentSession('chat')
    api.disconnectAgentLink('host')
    const replacement = api.getOrCreateAgentLink(host)
    fixture.idle!()
    expect(old.shutdown).toHaveBeenCalledOnce()
    expect(replacement.shutdown).not.toHaveBeenCalled()
    expect(api.getAgentLink('host')).toBe(replacement)
    api.disconnectAgentLink('host')
  })
})
