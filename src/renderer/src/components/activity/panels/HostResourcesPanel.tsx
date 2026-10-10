import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SshConnectionSession } from '@shared/types'
import { isNetworkDevice } from '@shared/device'
import { errorMessage } from '@shared/error'
import { useAiStore } from '@/stores/ai'
import { useConnectionsStore } from '@/stores/connections'
import { useSessionStore } from '@/stores/session'
import { useWorkspaceStore } from '@/stores/workspace'
import { Button } from '@/components/form/Buttons'
import { ActivityPanelHeader } from '../ActivityPanelHeader'
import { PerformancePanel } from './PerformancePanel'
import { resourceHostId } from '@/lib/resourceHost'

/** Inspect performance without creating a terminal shell. */
export function HostResourcesPanel({ visible }: { visible: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const connections = useConnectionsStore((s) => s.connections)
  const hosts = useSessionStore((s) => s.hosts)
  const focusedId = useWorkspaceStore((s) => s.focusedHostId)
  const sessionId = useAiStore((s) => s.activeId)
  const [links, setLinks] = useState<SshConnectionSession[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const hostId = resourceHostId(connections, links, sessionId, focusedId)
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
    if (!visible || unsupported || host?.phase !== 'connected') return
    window.aterm.perf.watchSession(hostId)
    return () => window.aterm.perf.watchSession(null)
  }, [unsupported, hostId, host?.phase, visible])

  return (
    <div className="flex h-full min-w-0 flex-col">
      <ActivityPanelHeader>
        <span className="shrink-0 text-body font-medium text-fg">{t('activity.performance')}</span>
        {conn && (
          <span
            className="ml-auto min-w-0 truncate text-caption text-muted"
            title={`${conn.username}@${conn.host}:${conn.port}`}
          >
            {conn.name}
          </span>
        )}
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
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <PerformancePanel key={conn.id} hostId={conn.id} />
        </div>
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
