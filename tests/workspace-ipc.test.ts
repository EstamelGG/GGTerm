import { beforeEach, expect, it, vi } from 'vitest'
import type { HostLinkEvents } from '../src/main/ssh/link'
type Handler = (...args: unknown[]) => unknown
const state = vi.hoisted(() => ({
  invoke: new Map<string, Handler>(),
  send: new Map<string, Handler>(),
  get: vi.fn(),
  create: vi.fn(),
  resource: vi.fn(),
  remove: vi.fn(),
  select: vi.fn(),
  autoStart: vi.fn(),
  closeHost: vi.fn(),
  registerSftp: vi.fn(),
  subscribe: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: Handler) => {
      if (state.invoke.has(name)) throw new Error('duplicate')
      state.invoke.set(name, handler)
    },
    on: (name: string, handler: Handler) => {
      if (state.send.has(name)) throw new Error('duplicate')
      state.send.set(name, handler)
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../src/main/connections', () => ({ listConnections: () => [] }))
vi.mock('../src/main/ssh/link', () => ({
  getLink: state.get,
  getOrCreateLink: state.create,
  removeLink: state.remove,
  probeLinksOsName: vi.fn()
}))
vi.mock('../src/main/ssh/resourceLink', () => ({ getResourceLink: state.resource }))
vi.mock('../src/main/ssh/connectionRegistry', () => ({
  connectionRegistry: {
    snapshot: () => ({ revision: 0, connections: [] }),
    subscribe: state.subscribe
  }
}))
vi.mock('../src/main/ai/agentLinks', () => ({
  listAgentConnections: () => [],
  closeAgentConnection: vi.fn(),
  closeSelectedConnections: state.select
}))
vi.mock('../src/main/portForward', () => ({
  configureForward: vi.fn(),
  controlForward: vi.fn(),
  setForwardLinkResolver: vi.fn(),
  portForwards: {
    list: () => [],
    probe: vi.fn(),
    autoStart: state.autoStart,
    closeHost: state.closeHost
  }
}))
vi.mock('../src/main/ipc/sftp', () => ({ registerSftpIpc: state.registerSftp }))
import { registerWorkspaceIpc } from '../src/main/ipc/workspace'
beforeEach(() => {
  vi.resetAllMocks()
  state.invoke.clear()
  state.send.clear()
  registerWorkspaceIpc()
})
it('keeps inspect-only connections separate from user SSH and preserves the reply shape', () => {
  state.resource.mockReturnValue({ activeClient: {}, phase: 'connected' })
  const result = state.invoke.get('host:connect')!({ sender: {} }, { id: 'host' }, true)
  expect(result).toEqual({ awaiting: false, viewerOnly: true, phase: 'connected' })
  expect(state.create).not.toHaveBeenCalled()
})
it('retains manual login and starts an ordinary shell only when explicitly requested', () => {
  const shell = { id: 'shell' }
  const link = {
    awaitingCredentials: true,
    start: vi.fn(),
    emitCurrentState: vi.fn(),
    addShell: vi.fn(() => shell),
    startShell: vi.fn()
  }
  state.create.mockReturnValue(link)
  state.get.mockReturnValue(link)
  const result = state.invoke.get('host:connect')!(
    { sender: { isDestroyed: () => false, send: vi.fn() } },
    { id: 'host' }
  )
  expect(result).toEqual({ awaiting: true })
  expect(link.start).not.toHaveBeenCalled()
  expect(link.emitCurrentState).toHaveBeenCalledOnce()
  expect(state.invoke.get('shell:create')!({}, { hostId: 'host', bootstrap: 'pwd' })).toEqual({
    shellId: 'shell'
  })
  expect(link.addShell).toHaveBeenCalledWith('pwd')
  expect(link.startShell).not.toHaveBeenCalled()
  state.send.get('shell:start')!({}, { hostId: 'host', shellId: 'shell' })
  expect(link.startShell).toHaveBeenCalledWith('shell')
})
it('shares one event factory with SFTP and preserves sender isolation and forwarding transitions', () => {
  const factory = state.registerSftp.mock.calls[0][0] as (sender: unknown) => HostLinkEvents
  const send = vi.fn()
  let destroyed = false
  const events = factory({ isDestroyed: () => destroyed, send })
  events.onHostState({ hostId: 'host', phase: 'connected', since: 1 })
  events.onHostState({ hostId: 'host', phase: 'connected', since: 2 })
  expect(state.autoStart).toHaveBeenCalledOnce()
  events.onShellData({ hostId: 'host', shellId: 'shell', data: 'live' })
  destroyed = true
  events.onShellData({ hostId: 'host', shellId: 'shell', data: 'late' })
  expect(send).toHaveBeenCalledOnce()
  expect(send).toHaveBeenCalledWith('shell:data', expect.objectContaining({ data: 'live' }))
  events.onHostState({ hostId: 'host', phase: 'idle', since: 3 })
  expect(state.closeHost).toHaveBeenCalledWith('host', 'user')
  events.onHostState({ hostId: 'host', phase: 'connected', since: 4 })
  expect(state.autoStart).toHaveBeenCalledTimes(2)
})
it('validates selective close and delegates the exact transport IDs', () => {
  const close = state.invoke.get('host:closeConnections')!
  expect(() => close({}, 'host', [123])).toThrow('Invalid connection selection')
  close({}, 'host', ['old-transport'])
  expect(state.select).toHaveBeenCalledWith('host', ['old-transport'])
  expect(state.remove).not.toHaveBeenCalled()
})
