import { BrowserWindow, ipcMain } from 'electron'
import type { PortForwardAction, PortForwardInput } from '../../shared/portForward'
import type { HostConnection, SshConnectionSession } from '../../shared/types'
import {
  closeAgentConnection,
  closeSelectedConnections,
  listAgentConnections
} from '../ai/agentLinks'
import * as connections from '../connections'
import {
  configureForward,
  controlForward,
  portForwards,
  setForwardLinkResolver
} from '../portForward'
import { connectionRegistry } from '../ssh/connectionRegistry'
import type { HostLinkEvents } from '../ssh/link'
import { getLink, getOrCreateLink, listLinks, probeLinksOsName, removeLink } from '../ssh/link'
import { getResourceLink } from '../ssh/resourceLink'

import { channels } from './channels'
import { registerSftpIpc } from './sftp'

export function registerWorkspaceIpc(): void {
  ipcMain.handle('port-forward:list', () => portForwards.list())
  ipcMain.handle('port-forward:configure', (_e, input: PortForwardInput, id?: string) =>
    configureForward(input, id)
  )
  ipcMain.handle('port-forward:control', (_e, id: string, action: PortForwardAction) =>
    controlForward(id, action)
  )
  ipcMain.handle('port-forward:probe', (_e, id: string) => portForwards.probe(id))
  /** 主机链路事件转发器（固定回发起连接的 renderer） */
  const forwardConnectedHosts = new Set<string>()
  const linkEvents = (sender: Electron.WebContents): HostLinkEvents => ({
    onHostState: (payload) => {
      if (!sender.isDestroyed()) sender.send('host:state', payload)
      if (payload.phase === 'connected' && !forwardConnectedHosts.has(payload.hostId)) {
        forwardConnectedHosts.add(payload.hostId)
        portForwards.autoStart(payload.hostId)
      }
      if (payload.phase === 'idle') {
        forwardConnectedHosts.delete(payload.hostId)
        void portForwards.closeHost(payload.hostId, 'user')
      }
    },
    onShellState: (payload) => {
      if (!sender.isDestroyed()) sender.send('shell:state', payload)
    },
    onShellData: (payload) => {
      if (!sender.isDestroyed()) sender.send('shell:data', payload)
    },
    onShellAnnounce: (payload) => {
      if (!sender.isDestroyed()) sender.send('shell:announce', payload)
    },
    onSftpState: (payload) => {
      if (!sender.isDestroyed()) sender.send('sftp:state', payload)
    },
    onSftpTransfer: (payload) => {
      if (!sender.isDestroyed()) sender.send('sftp:transfer', payload)
    },
    onSftpMeasure: (payload) => {
      if (!sender.isDestroyed()) sender.send('sftp:measure', payload)
    }
  })

  setForwardLinkResolver(async (hostId) => {
    const conn = connections.listConnections().find((c) => c.id === hostId)
    const sender = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())?.webContents
    if (!conn || !sender) throw new Error('SSH host or app window not found')
    const link = getOrCreateLink(conn, linkEvents(sender))
    if (link.awaitingCredentials)
      throw new Error('Connect this host and enter its credentials first')
    link.start()
    return link
  })

  ipcMain.handle(channels.linksList, () => listLinks())
  ipcMain.handle('connections:runtime', () => connectionRegistry.snapshot())
  connectionRegistry.subscribe((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('connections:state', event)
    }
  })

  ipcMain.on(channels.osProbe, (_e, { hostIds }: { hostIds: string[] }) => {
    probeLinksOsName(hostIds)
  })

  ipcMain.handle(channels.hostConnect, (e, conn: HostConnection, inspectOnly = false) => {
    const resource = inspectOnly ? getResourceLink(conn.id) : undefined
    if (resource?.activeClient && resource !== getLink(conn.id))
      return { awaiting: false, viewerOnly: true, phase: resource.phase }

    const link = getOrCreateLink(conn, linkEvents(e.sender))
    if (!link.awaitingCredentials) link.start()
    link.emitCurrentState()
    return { awaiting: link.awaitingCredentials }
  })

  ipcMain.on(
    channels.hostSubmitAuth,
    (
      _e,
      {
        hostId,
        username,
        password,
        privateKey,
        passphrase
      }: {
        hostId: string
        username: string
        password?: string
        privateKey?: string
        passphrase?: string
      }
    ) => {
      const link = getLink(hostId)
      if (!link || !username.trim() || (!password && !privateKey)) return
      const conn = { ...link.connection, username: username.trim() }
      link.update(conn, {
        password: password ?? '',
        privateKey: privateKey ?? '',
        passphrase: passphrase ?? ''
      })
      link.start()
    }
  )

  ipcMain.on(channels.hostReconnect, (_e, hostId: string) => {
    getLink(hostId)?.start()
  })

  ipcMain.on(channels.hostRestart, (_e, hostId: string) => {
    getLink(hostId)?.restart()
  })

  ipcMain.handle('host:connectionSessions', (_e, hostIds: string[]) => {
    if (!Array.isArray(hostIds) || hostIds.some((id) => typeof id !== 'string'))
      throw new Error('Invalid hosts')
    return hostIds
      .flatMap<SshConnectionSession>((hostId) => {
        const link = getLink(hostId)
        return link
          ? [
              {
                hostId,
                connectionId: link.connectionId,
                owner: 'user' as const,
                shellCount: [...link.shells.values()].filter(
                  (shell) => shell.status === 'connected' || shell.status === 'connecting'
                ).length,
                phase: link.phase,
                since: link.phaseSince
              }
            ]
          : []
      })
      .concat(listAgentConnections().filter((item) => hostIds.includes(item.hostId)))
  })
  ipcMain.handle('agent:links', () => listAgentConnections())
  ipcMain.handle('host:closeConnections', (_e, hostId: string, ids: string[]) => {
    if (
      typeof hostId !== 'string' ||
      !Array.isArray(ids) ||
      ids.some((id) => typeof id !== 'string')
    )
      throw new Error('Invalid connection selection')
    // Match actual transport IDs, so a stale selection never closes a replacement connection.
    return closeSelectedConnections(hostId, ids)
  })
  ipcMain.on(channels.hostClose, (_e, hostId: string, agentConnectionIds?: string[]) => {
    if (typeof hostId !== 'string') return
    if (Array.isArray(agentConnectionIds)) {
      for (const id of agentConnectionIds)
        if (typeof id === 'string') closeAgentConnection(hostId, id)
    }
    removeLink(hostId)
  })

  ipcMain.handle(
    channels.shellCreate,
    (_e, { hostId, bootstrap }: { hostId: string; bootstrap?: string }) => {
      const link = getLink(hostId)
      if (!link) throw new Error('host not connected')
      const shell = link.addShell(bootstrap)
      return { shellId: shell.id }
    }
  )

  // 延迟启动协议：渲染层 xterm 实例/镜像就绪后请求开通道（fire-and-forget；主进程另有 3.5s 兜底）
  ipcMain.on(
    channels.shellStart,
    (_e, { hostId, shellId }: { hostId: string; shellId: string }) => {
      getLink(hostId)?.startShell(shellId)
    }
  )

  ipcMain.on(
    channels.shellInput,
    (_e, { hostId, shellId, data }: { hostId: string; shellId: string; data: string }) => {
      getLink(hostId)?.shells.get(shellId)?.write(data)
    }
  )

  ipcMain.on(
    channels.shellResize,
    (
      _e,
      {
        hostId,
        shellId,
        cols,
        rows
      }: { hostId: string; shellId: string; cols: number; rows: number }
    ) => {
      getLink(hostId)?.shells.get(shellId)?.resize(cols, rows)
    }
  )

  ipcMain.on(
    channels.shellClose,
    (_e, { hostId, shellId }: { hostId: string; shellId: string }) => {
      getLink(hostId)?.removeShell(shellId)
    }
  )

  ipcMain.on(
    channels.shellRestart,
    (_e, { hostId, shellId }: { hostId: string; shellId: string }) => {
      const shell = getLink(hostId)?.shells.get(shellId)
      shell?.start()
    }
  )

  registerSftpIpc(linkEvents)
}
