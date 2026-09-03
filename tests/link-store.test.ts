// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { useLinksStore } from '../src/renderer/src/stores/links'
import type { HostLinkSnapshot, HostStateEvent, SshConnectionSession } from '../src/shared/types'

afterEach(() => useLinksStore.setState({ byHost: {} }))

function setup(): {
  emit: (event: HostStateEvent) => void
  emitAgent: (event: SshConnectionSession) => void
  resolve: (snapshot: HostLinkSnapshot[]) => void
  off: ReturnType<typeof vi.fn>
} {
  let emit!: (event: HostStateEvent) => void
  let emitAgent!: (event: SshConnectionSession) => void
  let resolve!: (snapshot: HostLinkSnapshot[]) => void
  const off = vi.fn()
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      hosts: {
        onAgentState: (listener: typeof emitAgent) => {
          emitAgent = listener
          return () => {}
        },
        listAgentLinks: async () => [],
        onState: (listener: typeof emit) => {
          emit = listener
          return off
        },
        listLinks: () =>
          new Promise<HostLinkSnapshot[]>((r) => {
            resolve = r
          })
      }
    }
  })
  return {
    emit: (event) => emit(event),
    emitAgent: (event) => emitAgent(event),
    resolve: (snapshot) => resolve(snapshot),
    off
  }
}

it('does not overwrite a live event with a delayed initial snapshot', async () => {
  const fixture = setup()
  const stop = useLinksStore.getState().watch()
  fixture.emit({ hostId: 'host', phase: 'connected', since: 2 } as HostStateEvent)
  fixture.resolve([{ hostId: 'host', phase: 'connecting', since: 1 } as HostLinkSnapshot])
  await Promise.resolve()
  expect(useLinksStore.getState().byHost.host.phase).toBe('connected')
  stop()
  expect(fixture.off).toHaveBeenCalledOnce()
})

it('ignores snapshot replies after unsubscribe', async () => {
  const fixture = setup()
  const stop = useLinksStore.getState().watch()
  stop()
  fixture.resolve([{ hostId: 'host', phase: 'connected', since: 1 } as HostLinkSnapshot])
  await Promise.resolve()
  expect(useLinksStore.getState().byHost).toEqual({})
})

it('keeps the host online until both user and Agent transports have closed', () => {
  const fixture = setup()
  const stop = useLinksStore.getState().watch()
  fixture.emit({ hostId: 'host', phase: 'connected', since: 1 })
  const agent: SshConnectionSession = {
    hostId: 'host',
    connectionId: 'agent-1',
    owner: 'agent',
    sessionId: 'a',
    phase: 'connected',
    since: 2
  }
  fixture.emitAgent(agent)
  fixture.emit({ hostId: 'host', phase: 'idle', since: 3 })
  expect(useLinksStore.getState().byHost.host.phase).toBe('connected')
  fixture.emitAgent({ ...agent, phase: 'idle', since: 4 })
  expect(useLinksStore.getState().byHost.host.phase).toBe('idle')
  fixture.emit({ hostId: 'host', phase: 'connected', since: 5 })
  fixture.emitAgent({ ...agent, phase: 'offline', since: 6 })
  expect(useLinksStore.getState().byHost.host.phase).toBe('connected')
  stop()
})
