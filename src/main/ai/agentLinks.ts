import { AsyncLocalStorage } from 'node:async_hooks'
import { BrowserWindow } from 'electron'
import { HostLink, getLink, removeLink } from '../ssh/link'
import type { HostConnection, HostStateEvent, SshConnectionSession } from '../../shared/types'
import { executions } from './exec'

export const agentConnectionContext = new AsyncLocalStorage<string>()
const links = new Map<string, { sessionId: string; link: HostLink }>()
const keyOf = (hostId: string): string => {
  const owner = agentConnectionContext.getStore()
  if (!owner) throw new Error('Agent connection requires an AI session')
  return JSON.stringify([owner, hostId])
}

export function getAgentLink(hostId: string): HostLink | undefined {
  return links.get(keyOf(hostId))?.link
}

export function getOrCreateAgentLink(conn: HostConnection): HostLink {
  const key = keyOf(conn.id)
  const existing = links.get(key)
  if (existing) {
    existing.link.update(conn)
    return existing.link
  }
  const sessionId = agentConnectionContext.getStore()!
  const sendState = (state: HostStateEvent): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        window.webContents.send('agent:host:state', {
          ...state,
          connectionId: link.connectionId,
          sessionId,
          owner: 'agent'
        })
    }
  }
  // A separate HostLink creates its own Client, jump clients and SFTP channel.
  // Agent state never enters the user's host/shell/SFTP event stream.
  const noop = (): void => {}
  const link = new HostLink(
    conn.id,
    conn,
    {
      onHostState: sendState,
      onShellState: noop,
      onShellData: noop,
      onShellAnnounce: noop,
      onSftpState: noop,
      onSftpTransfer: noop,
      onSftpMeasure: noop
    },
    { probeOs: false }
  )
  links.set(key, { sessionId, link })
  return link
}

/** 主机上属于某会话的运行中执行数（与 listAgentConnections 口径一致） */
function runningExecutionsOf(sessionId: string, hostId: string): number {
  return executions
    .list(sessionId)
    .filter(
      (task) =>
        task.hostId === hostId &&
        (task.status === 'starting' || task.status === 'running') &&
        !task.terminationRequested
    ).length
}

export function listAgentConnections(): SshConnectionSession[] {
  return [...links.values()].map(({ sessionId, link }) => ({
    connectionId: link.connectionId,
    hostId: link.hostId,
    owner: 'agent',
    sessionId,
    shellCount: runningExecutionsOf(sessionId, link.hostId),
    phase: link.phase,
    since: link.phaseSince,
    jumpIds: link.effectiveJumpIds,
    attempt: link.attempt,
    reason: link.offlineReason
  }))
}

export function closeAgentConnection(hostId: string, connectionId: string): void {
  for (const [key, entry] of links) {
    if (entry.link.hostId !== hostId || entry.link.connectionId !== connectionId) continue
    executions.closeHost(hostId, entry.sessionId)
    entry.link.shutdown()
    links.delete(key)
  }
}

export function disconnectAgentLink(hostId: string): void {
  const link = getAgentLink(hostId)
  if (link) closeAgentConnection(hostId, link.connectionId)
}

/** 对话关闭时回收其全部链路：空闲即关；有执行在跑的等该会话执行全部完结后再关 */
export function reclaimAgentSession(sessionId: string): void {
  for (const [key, entry] of [...links]) {
    if (entry.sessionId !== sessionId) continue
    if (runningExecutionsOf(sessionId, entry.link.hostId) === 0) {
      executions.closeHost(entry.link.hostId, sessionId)
      entry.link.shutdown()
      links.delete(key)
    }
  }
  if ([...links.values()].some((e) => e.sessionId === sessionId)) {
    executions.onSessionIdle(sessionId, () => {
      for (const [key, entry] of [...links]) {
        if (entry.sessionId !== sessionId) continue
        executions.closeHost(entry.link.hostId, sessionId)
        entry.link.shutdown()
        links.delete(key)
      }
    })
  }
}

export function closeSelectedConnections(hostId: string, ids: string[]): { userClosed: boolean } {
  for (const id of ids) closeAgentConnection(hostId, id)
  const user = getLink(hostId)
  const userClosed = !!user && ids.includes(user.connectionId)
  if (userClosed) removeLink(hostId)
  return { userClosed }
}
