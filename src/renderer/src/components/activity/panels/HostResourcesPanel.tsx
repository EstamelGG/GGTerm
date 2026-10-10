import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SshConnectionSession } from '@shared/types'
import { isNetworkDevice } from '@shared/device'
import { shellQuote } from '@shared/sftpPath'
import { errorMessage } from '@shared/error'
import { useAiStore } from '@/stores/ai'
import { useConnectionsStore } from '@/stores/connections'
import { useSessionStore } from '@/stores/session'
import { useWorkspaceStore } from '@/stores/workspace'
import { SftpPane } from '@/components/sftp/SftpPane'
import { Button } from '@/components/form/Buttons'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ActivityPanelHeader } from '../ActivityPanelHeader'
import { PerformancePanel } from './PerformancePanel'
import { resourceHostId } from '@/lib/resourceHost'

/** Files and performance can be inspected without creating a terminal shell. */
export function HostResourcesPanel({
  panel,
  visible
}: {
  visible: boolean
  panel: 'files' | 'performance'
}): React.JSX.Element {
  const { t } = useTranslation()
  const connections = useConnectionsStore((s) => s.connections)
  const hosts = useSessionStore((s) => s.hosts)
  const focusedId = useWorkspaceStore((s) => s.focusedHostId)
  const sessionId = useAiStore((s) => s.activeId)
  const [links, setLinks] = useState<SshConnectionSession[]>([])
  const selectedId = useWorkspaceStore((s) => s.inspectedHostId)
  const [notice, setNotice] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const hostId = resourceHostId(connections, links, sessionId, selectedId, focusedId)
  const conn = connections.find((c) => c.id === hostId)
  const host = hosts.find((h) => h.id === hostId)
  const unsupported = isNetworkDevice(conn)

  useEffect(() => {
    let live = true
    let changed = false
    const off = window.aterm.hosts.onAgentState((next) => {
      changed = true
      setLinks((previous) => [
        ...previous.filter((link) => link.connectionId !== next.connectionId),
        next
      ])
    })
    void window.aterm.hosts
      .listAgentLinks()
      .then((next) => {
        if (live && !changed) setLinks(next)
      })
      .catch(() => {})
    return () => {
      live = false
      off()
    }
  }, [])

  useEffect(() => {
    if (!visible || !conn || unsupported) return
    let live = true
    void useSessionStore
      .getState()
      .connect(conn, false)
      .then(() => {
        if (live) setNotice(null)
      })
      .catch((error) => {
        if (live) setNotice(errorMessage(error))
      })
    return () => {
      live = false
    }
  }, [conn, unsupported, retry, visible])

  useEffect(() => {
    if (!visible || panel !== 'performance' || unsupported || host?.phase !== 'connected') return
    window.aterm.perf.watchSession(hostId)
    return () => window.aterm.perf.watchSession(null)
  }, [panel, unsupported, hostId, host?.phase, visible])

  return (
    <div className="flex h-full min-w-0 flex-col">
      <ActivityPanelHeader>
        <span className="shrink-0 text-body font-medium text-fg">
          {t(panel === 'files' ? 'activity.files' : 'activity.performance')}
        </span>
        <div className="ml-auto min-w-0">
          <Select
            value={hostId ?? ''}
            onValueChange={(id) => {
              useWorkspaceStore.getState().inspectHost(id)
              setNotice(null)
            }}
          >
            <SelectTrigger aria-label={t('activity.selectHost')}>
              <SelectValue placeholder={t('activity.selectHost')} />
            </SelectTrigger>
            <SelectContent>
              {connections.map((connection) => (
                <SelectItem key={connection.id} value={connection.id}>
                  {connection.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </ActivityPanelHeader>
      {notice && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2 text-minor text-danger"
        >
          <span className="min-w-0 flex-1 break-words">{notice}</span>
          <Button
            variant="ghost"
            size="sm"
            title={t('activity.retryResources')}
            onClick={() => setRetry((value) => value + 1)}
          />
        </div>
      )}
      {!conn ? (
        <p className="p-6 text-center text-minor text-muted">{t('activity.selectHostHint')}</p>
      ) : unsupported ? (
        <p className="p-6 text-minor text-muted">{t('conn.form.networkHint')}</p>
      ) : host?.awaiting ? (
        <div className="flex flex-col items-center gap-3 p-6 text-center text-minor text-muted">
          <p>{t('activity.resourcesAuth')}</p>
          <Button
            title={t('activity.openHost')}
            onClick={() => useSessionStore.getState().setTab({ kind: 'host', id: conn.id })}
          />
        </div>
      ) : host?.phase === 'connected' ? (
        panel === 'files' ? (
          <div className="min-h-0 flex-1">
            <SftpPane
              key={conn.id}
              hostId={conn.id}
              onToast={setNotice}
              onOpenTerminal={(dir) => {
                const store = useSessionStore.getState()
                store.addShell(conn.id, `cd ${shellQuote(dir)}`)
                store.setTab({ kind: 'host', id: conn.id })
              }}
              onOpenFile={(entry) => {
                const store = useSessionStore.getState()
                store.openFile(conn.id, entry)
                store.setTab({ kind: 'host', id: conn.id })
              }}
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <PerformancePanel key={conn.id} hostId={conn.id} />
          </div>
        )
      ) : (
        <div className="flex flex-col items-center gap-3 p-6 text-center text-minor text-muted">
          <p>
            {host?.phase === 'offline' || host?.phase === 'idle'
              ? host.offlineReason || t('activity.resourcesOffline')
              : t('activity.resourcesConnecting')}
          </p>
          {(host?.phase === 'offline' || host?.phase === 'idle') && (
            <Button
              variant="ghost"
              title={t('activity.retryResources')}
              onClick={() => setRetry((value) => value + 1)}
            />
          )}
        </div>
      )}
    </div>
  )
}
