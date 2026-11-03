import type { HostLinkEvents } from '../src/main/ssh/link'
interface FixtureLink {
  activeClient: object | null
  sftp: { stop: ReturnType<typeof vi.fn> }
  ownTransportResource?: (dispose: () => void) => () => void
}
import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  user: undefined as FixtureLink | undefined,
  agent: undefined as FixtureLink | undefined,
  channels: [] as unknown[]
}))
vi.mock('../src/main/ssh/link', () => ({ getLink: () => state.user }))
vi.mock('../src/main/ai/agentLinks', () => ({ findAgentResourceLink: () => state.agent }))
vi.mock('../src/main/ssh/sftp', () => ({
  SftpSession: class {
    stop = vi.fn()
    hostLinkLost = vi.fn()
    constructor(public link: unknown) {
      state.channels.push(this)
    }
  }
}))
beforeEach(() => {
  state.user = undefined
  state.agent = undefined
  state.channels = []
  vi.resetModules()
})
function agentLink(): FixtureLink {
  return { activeClient: {}, sftp: { stop: vi.fn() }, ownTransportResource: () => () => {} }
}
it('borrows Agent transport when the user has no active connection, preferring a live user transport', async () => {
  const api = await import('../src/main/ssh/resourceLink')
  state.agent = agentLink()
  expect(api.getResourceLink('host')).toBe(state.agent)
  state.user = { activeClient: null, sftp: { stop: vi.fn() } }
  expect(api.getResourceLink('host')).toBe(state.agent)
  state.user.activeClient = {}
  expect(api.getResourceLink('host')).toBe(state.user)
})
it('opens a separate UI SFTP channel and stopping it leaves Agent SFTP untouched', async () => {
  const api = await import('../src/main/ssh/resourceLink')
  state.agent = agentLink()
  const events = {} as HostLinkEvents
  const channel = api.resourceSftp('host', events)
  expect(channel).not.toBe(state.agent.sftp)
  expect(api.resourceSftp('host', events)).toBe(channel)
  api.stopResourceSftp('host')
  expect(channel.stop).toHaveBeenCalledOnce()
  expect(state.agent.sftp.stop).not.toHaveBeenCalled()
})
it('discards stale UI channels when the Agent transport reconnects', async () => {
  const api = await import('../src/main/ssh/resourceLink')
  state.agent = agentLink()
  const old = api.resourceSftp('host', {} as HostLinkEvents)
  state.agent.activeClient = {}
  expect(api.resourceSftp('host', {} as HostLinkEvents)).not.toBe(old)
  expect(old.stop).toHaveBeenCalledOnce()
  expect(state.agent.sftp.stop).not.toHaveBeenCalled()
})
it('immediately releases borrowed channels on transport loss without another UI request', async () => {
  const api = await import('../src/main/ssh/resourceLink')
  let dispose!: () => void
  state.agent = agentLink()
  state.agent.ownTransportResource = (callback) => {
    dispose = callback
    return () => {}
  }
  const old = api.resourceSftp('host', {} as HostLinkEvents)
  dispose()
  expect(old.stop).toHaveBeenCalledOnce()
  expect(state.agent.sftp.stop).not.toHaveBeenCalled()
  expect(api.resourceSftp('host', {} as HostLinkEvents)).not.toBe(old)
})
