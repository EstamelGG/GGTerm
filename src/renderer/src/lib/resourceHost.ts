import type { HostConnection, SshConnectionSession } from '@shared/types'

/** Explicit selection wins; otherwise follow the current Agent conversation before shell focus. */
export function resourceHostId(
  hosts: Pick<HostConnection, 'id'>[],
  links: Pick<SshConnectionSession, 'hostId' | 'sessionId' | 'phase'>[],
  sessionId: string | null,
  selectedId: string | null,
  focusedId: string | null
): string | null {
  const available = (id: string | null | undefined): id is string =>
    !!id && hosts.some((h) => h.id === id)
  if (available(selectedId)) return selectedId
  const agent = links.find(
    (link) => link.sessionId === sessionId && link.phase === 'connected' && available(link.hostId)
  )
  if (agent) return agent.hostId
  return available(focusedId) ? focusedId : null
}
