import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  user: undefined as any,
  agent: undefined as any,
  channels: [] as any[]
}))
vi.mock('../src/main/ssh/link', () => ({ getLink: () => state.user }))
vi.mock('../src/main/ai/agentLinks', () => ({ findAgentResourceLink: () => state.agent }))
vi.mock('../src/main/ssh/sftp', () => ({
  SftpSession: class {
    stop = vi.fn()
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
it('borrows Agent transport when the user has no active connection, preferring a live user transport', async () => {
  const api = await import('../src/main/ssh/resourceLink')
  state.agent = { activeClient: {}, sftp: { stop: vi.fn() } }
  expect(api.getResourceLink('host')).toBe(state.agent)
  state.user = { activeClient: null, sftp: { stop: vi.fn() } }
  expect(api.getResourceLink('host')).toBe(state.agent)
  state.user.activeClient = {}
  expect(api.getResourceLink('host')).toBe(state.user)
})
it('opens a separate UI SFTP channel and stopping it leaves Agent SFTP untouched', async () => {
  const api = await import('../src/main/ssh/resourceLink')
  state.agent = { activeClient: {}, sftp: { stop: vi.fn() } }
  const events = {} as any
  const channel = api.resourceSftp('host', events)
  expect(channel).not.toBe(state.agent.sftp)
  expect(api.resourceSftp('host', events)).toBe(channel)
  api.stopResourceSftp('host')
  expect(channel.stop).toHaveBeenCalledOnce()
  expect(state.agent.sftp.stop).not.toHaveBeenCalled()
})
it('discards stale UI channels when the Agent transport reconnects', async () => {
  const api = await import('../src/main/ssh/resourceLink')
  state.agent = { activeClient: {}, sftp: { stop: vi.fn() } }
  const old = api.resourceSftp('host', {} as any)
  state.agent.activeClient = {}
  expect(api.resourceSftp('host', {} as any)).not.toBe(old)
  expect(old.stop).toHaveBeenCalledOnce()
  expect(state.agent.sftp.stop).not.toHaveBeenCalled()
})
