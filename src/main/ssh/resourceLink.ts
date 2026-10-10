import { getLink, type HostLink, type HostLinkEvents } from './link'
import { findAgentResourceLink } from '../ai/agentLinks'
import { SftpSession } from './sftp'

/** Prefer a user's live transport; otherwise borrow an Agent transport for this host. */
export function getResourceLink(hostId: string): HostLink | undefined {
  const user = getLink(hostId)
  const agent = findAgentResourceLink(hostId)
  return user?.activeClient ? user : agent?.activeClient ? agent : (user ?? agent)
}
const viewers = new Map<
  string,
  { link: HostLink; client: HostLink['activeClient']; sftp: SftpSession }
>()
export function resourceSftp(hostId: string, events: HostLinkEvents): SftpSession {
  const link = getResourceLink(hostId)
  const old = viewers.get(hostId)
  if (old && (old.link !== link || old.client !== link?.activeClient)) {
    old.sftp.stop()
    viewers.delete(hostId)
  }
  if (!link) throw new Error('host not connected')
  if (link === getLink(hostId)) return link.sftp
  const existing = viewers.get(hostId)
  if (existing) return existing.sftp
  // Share only SSH transport. Stopping a UI pane must never stop Agent SFTP requests.
  const sftp = new SftpSession(link, events)
  viewers.set(hostId, { link, client: link.activeClient, sftp })
  return sftp
}
export function stopResourceSftp(hostId: string): void {
  const entry = viewers.get(hostId)
  if (entry) {
    entry.sftp.stop()
    viewers.delete(hostId)
  } else getLink(hostId)?.sftp.stop()
}
