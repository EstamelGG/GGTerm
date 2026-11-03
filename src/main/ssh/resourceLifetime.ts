import { randomUUID } from 'node:crypto'
import type { Client } from 'ssh2'
import type { ResourceIdentity } from '../../shared/resource'

interface Transport {
  connectionId: string
  generation: number
  abort: AbortController
}
const transports = new WeakMap<Client, Transport>()

export function bindTransport(client: Client, connectionId = randomUUID(), generation = 0): void {
  if (transports.has(client)) return
  const abort = new AbortController()
  transports.set(client, { connectionId, generation, abort })
  client.once?.('close', () => abort.abort())
  client.once?.('end', () => abort.abort())
}

export function invalidateTransport(client: Client): void {
  transports.get(client)?.abort.abort()
}

export interface ResourceLease {
  identity: ResourceIdentity
  signal: AbortSignal
  current: () => boolean
}

/** Shared invalidation rule for channels and samplers, including async callbacks and queued writes. */
export class ResourceLifetime {
  private abort = new AbortController()
  private generation = 0
  constructor(
    private readonly hostId: string,
    private readonly kind: ResourceIdentity['kind'],
    private readonly resourceId = randomUUID()
  ) {}

  get signal(): AbortSignal {
    return this.abort.signal
  }

  reset(): void {
    const old = this.abort
    this.abort = new AbortController()
    this.generation++
    old.abort()
  }

  capture(client?: Client | null): ResourceLease {
    if (client && !transports.has(client)) bindTransport(client)
    const transport = client ? transports.get(client) : undefined
    const generation = this.generation
    const signal = transport ? AbortSignal.any([this.signal, transport.abort.signal]) : this.signal
    return {
      identity: {
        hostId: this.hostId,
        kind: this.kind,
        resourceId: this.resourceId,
        generation,
        connectionId: transport?.connectionId,
        connectionGeneration: transport?.generation
      },
      signal,
      current: () => generation === this.generation && !signal.aborted
    }
  }
}
