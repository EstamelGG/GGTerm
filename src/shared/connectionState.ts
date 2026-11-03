import type { HostStateEvent } from './types'

/** Runtime identity is separate from the saved host and survives transport retries. */
export interface ConnectionState extends HostStateEvent {
  connectionId: string
  owner: 'user' | 'agent'
  sessionId?: string
  generation: number
  revision: number
  closed: boolean
}

export interface ConnectionStateEvent {
  state: ConnectionState
  removed?: boolean
}

export interface ConnectionStateSnapshot {
  revision: number
  connections: ConnectionState[]
}

export function connectionSlot(
  state: Pick<ConnectionState, 'owner' | 'sessionId' | 'hostId'>
): string {
  return JSON.stringify([state.owner, state.sessionId ?? null, state.hostId])
}
