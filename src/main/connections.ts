import { randomUUID } from 'node:crypto'
import type { ConnectionSecrets, HostConnection, ServerNote } from '../shared/types'
import * as records from './data/connections'
import * as secrets from './data/secrets'
import { perfForget, perfInvalidate } from './ssh/perfHub'
import { removeLink } from './ssh/link'
import { stopResourceSftp } from './ssh/resourceLink'
import { closeAgentConnection, listAgentConnections } from './ai/agentLinks'
import { portForwards } from './portForward'
import { connectionRegistry } from './ssh/connectionRegistry'

export {
  listConnections,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup
} from './data/connections'

const deleting = new Set<string>()
function assertWritable(id: string): void {
  if (deleting.has(id)) throw new Error('Connection deletion is in progress')
}

/** Persist credentials before publishing a record change; compensate if the record write fails. */
function withSecrets<T>(
  id: string,
  credentials: Partial<ConnectionSecrets> | undefined,
  write: () => T
): T {
  if (!credentials) return write()
  const previous = secrets.loadSecrets(id)
  try {
    secrets.saveSecrets(id, credentials)
    return write()
  } catch (error) {
    try {
      secrets.saveSecrets(id, previous)
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Connection save failed and credentials could not be restored'
      )
    }
    throw error
  }
}

export function createConnection(
  input: Parameters<typeof records.createConnection>[0],
  credentials?: Partial<ConnectionSecrets>
): HostConnection {
  const id = input.id ?? randomUUID()
  assertWritable(id)
  if (records.listConnections().some((connection) => connection.id === id))
    throw new Error('Connection already exists')
  return withSecrets(id, credentials, () => records.createConnection({ ...input, id }))
}

export function updateConnection(
  id: string,
  patch: Partial<HostConnection>,
  credentials?: Partial<ConnectionSecrets>
): HostConnection | null {
  assertWritable(id)
  const previous = records.listConnections().find((connection) => connection.id === id)
  if (!previous) return null
  const next = withSecrets(id, credentials, () =>
    Object.keys(patch).length ? records.updateConnection(id, patch) : previous
  )
  perfInvalidate(id)
  return next
}

export function saveConnectionSecrets(id: string, credentials: Partial<ConnectionSecrets>): void {
  if (!updateConnection(id, {}, credentials)) throw new Error(`Connection not found: ${id}`)
}

export function setNote(id: string, note: ServerNote): HostConnection | null {
  assertWritable(id)
  return records.setNote(id, note)
}

/** Closing transports is irreversible; a cleanup failure leaves the record available for retry. */
export async function deleteConnection(id: string): Promise<boolean> {
  assertWritable(id)
  if (!records.listConnections().some((connection) => connection.id === id)) return false
  const unblock = connectionRegistry.blockHost(id)
  deleting.add(id)
  try {
    await portForwards.detachHost(id)
    stopResourceSftp(id)
    removeLink(id)
    for (const connection of listAgentConnections()) {
      if (connection.hostId === id) closeAgentConnection(id, connection.connectionId)
    }
    const deleted = withSecrets(id, { password: '', privateKey: '', passphrase: '' }, () =>
      records.deleteConnection(id)
    )
    if (deleted) {
      perfForget(id)
      connectionRegistry.forgetHost(id)
    }
    return deleted
  } finally {
    deleting.delete(id)
    unblock()
  }
}
