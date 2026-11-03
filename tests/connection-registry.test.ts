import { expect, it } from 'vitest'
import { ConnectionRegistry } from '../src/main/ssh/connectionRegistry'
import type { ConnectionState } from '../src/shared/connectionState'

const state = (patch: Partial<ConnectionState> = {}): Omit<ConnectionState, 'revision'> => ({
  hostId: 'host',
  connectionId: 'one',
  owner: 'user',
  phase: 'connecting',
  since: 1,
  generation: 1,
  closed: false,
  ...patch
})
it('rejects events from superseded generations and disposed connection identities', () => {
  const registry = new ConnectionRegistry()
  registry.register(state())
  registry.update(state({ generation: 2, phase: 'connected' }))
  registry.update(state({ generation: 1, phase: 'offline' }))
  expect(registry.snapshot().connections[0].phase).toBe('connected')
  registry.register(state({ connectionId: 'two' }))
  registry.update(state({ phase: 'idle', generation: 3, closed: true }))
  expect(registry.snapshot().connections[0].connectionId).toBe('two')
})
it('orders both owners in one journal, removes deleted hosts, and isolates other hosts', () => {
  const registry = new ConnectionRegistry()
  const revisions: number[] = []
  registry.subscribe((event) => revisions.push(event.state.revision))
  registry.register(state())
  registry.register(state({ owner: 'agent', sessionId: 'chat', connectionId: 'agent' }))
  registry.register(state({ hostId: 'other', connectionId: 'other' }))
  registry.forgetHost('host')
  registry.update(state({ phase: 'connected' }))
  expect(registry.snapshot().connections.map((entry) => entry.hostId)).toEqual(['other'])
  expect(revisions).toEqual([1, 2, 3, 4, 5])
})
it('retains a closed state briefly without allowing late callbacks to reopen it', () => {
  const registry = new ConnectionRegistry()
  registry.register(state())
  registry.update(state({ phase: 'idle', closed: true, since: 10 }))
  registry.update(state({ phase: 'connected', generation: 2 }))
  expect(registry.snapshot(100).connections[0].closed).toBe(true)
  expect(registry.snapshot(300_010).connections).toEqual([])
})
