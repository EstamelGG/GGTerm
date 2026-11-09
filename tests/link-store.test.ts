// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { useLinksStore } from '../src/renderer/src/stores/links'
import type {
  ConnectionState,
  ConnectionStateEvent,
  ConnectionStateSnapshot
} from '../src/shared/connectionState'

const state = (revision: number, patch: Partial<ConnectionState> = {}): ConnectionState => ({
  hostId: 'host',
  connectionId: 'user-1',
  owner: 'user',
  phase: 'connected',
  since: revision,
  generation: 1,
  revision,
  closed: false,
  ...patch
})
const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  useLinksStore.setState({ byHost: {}, userByHost: {}, connections: [] })
})
function setup(): {
  emit: (event: ConnectionStateEvent) => void
  resolve: (snapshot: ConnectionStateSnapshot) => void
  off: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
} {
  let emit!: (event: ConnectionStateEvent) => void
  let resolve!: (snapshot: ConnectionStateSnapshot) => void
  const off = vi.fn()
  const subscribe = vi.fn((listener: typeof emit) => {
    emit = listener
    return off
  })
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      hosts: {
        onConnectionState: subscribe,
        runtimeSnapshot: () =>
          new Promise<ConnectionStateSnapshot>((r) => {
            resolve = r
          })
      }
    }
  })
  return { emit: (event) => emit(event), resolve: (snapshot) => resolve(snapshot), off, subscribe }
}
function watch(): () => void {
  const stop = useLinksStore.getState().watch()
  stops.push(stop)
  return stop
}
it('replays newer events over a delayed snapshot and rejects older events afterward', async () => {
  const fixture = setup()
  watch()
  fixture.emit({ state: state(3) })
  fixture.resolve({ revision: 2, connections: [state(2, { phase: 'connecting' })] })
  await Promise.resolve()
  fixture.emit({ state: state(1, { phase: 'offline' }) })
  expect(useLinksStore.getState().byHost.host.phase).toBe('connected')
})
it('ignores snapshot replies and queued events after unsubscribe', async () => {
  const fixture = setup()
  watch()()
  fixture.resolve({ revision: 1, connections: [state(1)] })
  fixture.emit({ state: state(2) })
  await Promise.resolve()
  expect(useLinksStore.getState().byHost).toEqual({})
})
it('keeps the host online until both user and Agent transports close', () => {
  const fixture = setup()
  watch()
  fixture.emit({ state: state(1) })
  fixture.emit({ state: state(2, { connectionId: 'agent', owner: 'agent', sessionId: 'chat' }) })
  fixture.emit({ state: state(3, { phase: 'idle', closed: true }) })
  expect(useLinksStore.getState().byHost.host.phase).toBe('connected')
  fixture.emit({
    state: state(4, {
      connectionId: 'agent',
      owner: 'agent',
      sessionId: 'chat',
      phase: 'idle',
      closed: true
    })
  })
  expect(useLinksStore.getState().byHost.host.phase).toBe('idle')
})
it('does not resurrect a removed host from a delayed snapshot or event', async () => {
  const fixture = setup()
  watch()
  fixture.emit({ state: state(3), removed: true })
  fixture.resolve({ revision: 2, connections: [state(2)] })
  await Promise.resolve()
  fixture.emit({ state: state(2) })
  expect(useLinksStore.getState().byHost).toEqual({})
})
it('does not let a late old connection close its replacement', () => {
  const fixture = setup()
  watch()
  fixture.emit({ state: state(3, { connectionId: 'replacement' }) })
  fixture.emit({ state: state(2, { phase: 'idle', closed: true }) })
  expect(useLinksStore.getState().connections[0].connectionId).toBe('replacement')
  expect(useLinksStore.getState().connections).toHaveLength(1)
})
it('shares a single subscription and releases it only after the last consumer', () => {
  const fixture = setup()
  const first = watch()
  const second = watch()
  expect(fixture.subscribe).toHaveBeenCalledOnce()
  first()
  first()
  expect(fixture.off).not.toHaveBeenCalled()
  second()
  expect(fixture.off).toHaveBeenCalledOnce()
})
