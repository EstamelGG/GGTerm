import type { HostConnection, SshConnectionSession } from '@shared/types'

/** Follow explicit host focus; use the current Agent conversation when no host is focused. */
export function resourceHostId(
  hosts: Pick<HostConnection, 'id'>[],
  links: Pick<SshConnectionSession, 'hostId' | 'sessionId' | 'phase'>[],
  sessionId: string | null,
  focusedId: string | null
): string | null {
  const available = (id: string | null | undefined): id is string =>
    !!id && hosts.some((h) => h.id === id)
  if (available(focusedId)) return focusedId
  const agent = links.find(
    (link) => link.sessionId === sessionId && link.phase === 'connected' && available(link.hostId)
  )
  if (agent) return agent.hostId
  return null
}
