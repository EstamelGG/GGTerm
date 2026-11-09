import {
  connectionSlot,
  type ConnectionState,
  type ConnectionStateEvent,
  type ConnectionStateSnapshot
} from '../../shared/connectionState'

/** One ordered journal for both owners; snapshots discard closed slots older than five minutes. */
export class ConnectionRegistry {
  private revision = 0
  private slots = new Map<string, ConnectionState>()
  private listeners = new Set<(event: ConnectionStateEvent) => void>()
  private blockedHosts = new Set<string>()

  assertAvailable(hostId: string): void {
    if (this.blockedHosts.has(hostId)) throw new Error('Connection deletion is in progress')
  }

  blockHost(hostId: string): () => void {
    this.assertAvailable(hostId)
    this.blockedHosts.add(hostId)
    let released = false
    return () => {
      if (released) return
      released = true
      this.blockedHosts.delete(hostId)
    }
  }

  subscribe(listener: (event: ConnectionStateEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  register(state: Omit<ConnectionState, 'revision'>): void {
    this.assertAvailable(state.hostId)
    this.publish(state)
  }

  update(state: Omit<ConnectionState, 'revision'>): void {
    const current = this.slots.get(connectionSlot(state))
    if (!current || current.closed || current.connectionId !== state.connectionId) return
    if (state.generation < current.generation) return
    this.publish(state)
  }

  private publish(state: Omit<ConnectionState, 'revision'>): void {
    const next = { ...state, jumpIds: state.jumpIds?.slice(), revision: ++this.revision }
    this.slots.set(connectionSlot(state), next)
    for (const listener of this.listeners) listener({ state: next })
  }

  forgetHost(hostId: string): void {
    for (const [slot, state] of this.slots) {
      if (state.hostId !== hostId) continue
      this.slots.delete(slot)
      const removed = { ...state, revision: ++this.revision }
      for (const listener of this.listeners) listener({ state: removed, removed: true })
    }
  }

  snapshot(now = Date.now()): ConnectionStateSnapshot {
    for (const [slot, state] of this.slots) {
      if (state.closed && now - state.since >= 5 * 60_000) this.slots.delete(slot)
    }
    return {
      revision: this.revision,
      connections: [...this.slots.values()].map((state) => ({
        ...state,
        jumpIds: state.jumpIds?.slice()
      }))
    }
  }
}

export const connectionRegistry = new ConnectionRegistry()
