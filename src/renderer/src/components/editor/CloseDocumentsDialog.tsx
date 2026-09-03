import { useEffect, useState } from 'react'
import type { SshConnectionSession } from '@shared/types'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '@/stores/session'
import { DialogShell } from '@/components/ui/DialogShell'
import { Button } from '@/components/form/Buttons'

export function CloseDocumentsDialog({
  documents,
  onClose,
  onCancel,
  message,
  hostIds,
  closing = false
}: {
  documents: { hostId: string; fileId: string; name: string }[]
  onClose: (agentConnectionIds?: string[]) => void
  onCancel: () => void
  message: string
  hostIds?: string[]
  closing?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const hosts = useSessionStore((s) => s.hosts)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [connections, setConnections] = useState<SshConnectionSession[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [connectionsError, setConnectionsError] = useState(false)
  useEffect(() => {
    if (!hostIds) return
    let live = true
    void window.aterm.hosts
      .connectionSessions(hostIds)
      .then((items) => {
        if (live) setConnections(items)
      })
      .catch(() => {
        if (live) setConnectionsError(true)
      })
    return () => {
      live = false
    }
  }, [hostIds])
  const closeSelected = (): void => onClose(selected)
  const docs = documents
    .map((item) => hosts.find((h) => h.id === item.hostId)?.files.find((f) => f.id === item.fileId))
    .filter((f) => f !== undefined)
  const saving = busy || closing || docs.some((f) => f.saving)
  const dirty = docs.some((f) => f.text !== f.saved)
  const saveAndClose = async (): Promise<void> => {
    setBusy(true)
    setFailed(false)
    try {
      for (const item of documents) {
        const doc = useSessionStore
          .getState()
          .hosts.find((h) => h.id === item.hostId)
          ?.files.find((f) => f.id === item.fileId)
        if (
          doc &&
          doc.text !== doc.saved &&
          !(await useSessionStore.getState().saveFile(item.hostId, item.fileId))
        ) {
          setFailed(true)
          return
        }
      }
      closeSelected()
    } finally {
      setBusy(false)
    }
  }
  return (
    <DialogShell
      open
      title={t('session.closeSessionTitle')}
      onOpenChange={(open) => !open && !saving && onCancel()}
      dismissable={!saving}
      width={460}
      footer={
        <>
          <Button variant="ghost" title={t('common.cancel')} disabled={saving} onClick={onCancel} />
          <Button
            variant="danger"
            title={t(dirty ? 'session.discardClose' : 'common.close')}
            disabled={saving}
            onClick={closeSelected}
          />
          {dirty && (
            <Button
              title={t('session.saveClose')}
              disabled={saving || docs.some((f) => f.loading || f.readOnly)}
              onClick={() => void saveAndClose()}
            />
          )}
        </>
      }
    >
      <p className="text-body text-muted">{message}</p>
      {hostIds && (
        <div className="mt-3 flex max-h-56 flex-col gap-2 overflow-auto">
          <p className="text-minor text-muted">{t('session.connectionSelection')}</p>
          {connections.map((connection) => (
            <label
              key={connection.connectionId}
              className="flex items-start gap-2 text-body text-fg"
            >
              <input
                type="checkbox"
                className="mt-1 accent-(--at-accent)"
                checked={connection.owner === 'user' || selected.includes(connection.connectionId)}
                disabled={saving || connection.owner === 'user'}
                onChange={(event) =>
                  setSelected((ids) =>
                    event.target.checked
                      ? [...ids, connection.connectionId]
                      : ids.filter((id) => id !== connection.connectionId)
                  )
                }
              />
              <span className="min-w-0">
                <span>
                  (
                  {t(
                    connection.owner === 'user'
                      ? 'session.connectionUser'
                      : 'session.connectionAgent'
                  )}
                  ){' '}
                </span>
                <span className="font-mono text-minor break-all">{connection.connectionId}</span>
                <span className="block text-caption text-muted">
                  {hosts.find((host) => host.id === connection.hostId)?.title ?? connection.hostId}
                </span>
              </span>
            </label>
          ))}
          {connectionsError && (
            <p role="alert" className="text-minor text-danger">
              {t('session.connectionLoadFailed')}
            </p>
          )}
        </div>
      )}
      {dirty && (
        <ul className="mt-3 max-h-40 overflow-auto text-body text-fg">
          {documents.map((doc) => (
            <li className="break-all" key={`${doc.hostId}:${doc.fileId}`}>
              {doc.name}
            </li>
          ))}
        </ul>
      )}
      {saving && (
        <p role="status" className="mt-3 text-body text-muted">
          {t('editor.saving')}
        </p>
      )}
      {failed && (
        <p role="alert" className="mt-3 whitespace-pre-wrap break-words text-body text-danger">
          {t('session.saveCloseFailed')}
          {'\n'}
          {docs
            .filter((d) => d.error)
            .map((d) => `${d.name}: ${d.error}`)
            .join('\n')}
        </p>
      )}
    </DialogShell>
  )
}
