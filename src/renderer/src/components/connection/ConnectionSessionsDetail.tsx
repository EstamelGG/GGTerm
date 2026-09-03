import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, TerminalSquare, UserRound } from 'lucide-react'
import type { SshConnectionSession } from '@shared/types'
import { errorMessage } from '@shared/error'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session'
import { useAiStore } from '@/stores/ai'
import { Button } from '@/components/form/Buttons'
import { CloseDocumentsDialog } from '@/components/editor/CloseDocumentsDialog'
import { linkStateDot, linkStateLabelKey } from '@/lib/linkPhase'
import { StateDot } from '@/components/ui/StateDot'
import { CopyIconButton, IconButton } from '@/components/ui/IconButton'

const ExecutionSessionsDialog = lazy(() => import('@/components/ai/ExecutionSessionsDialog'))

export function ConnectionSessionsDetail({
  hostId,
  name,
  items,
  onToast
}: {
  hostId: string
  name: string
  items: SshConnectionSession[]
  onToast: (message: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<string[]>([])
  const [pending, setPending] = useState<SshConnectionSession[] | null>(null)
  const [closing, setClosing] = useState(false)
  /** 命令执行会话弹窗：值 = 该 agent 连接所属 AI 会话 id（只看此连接的执行） */
  const [execView, setExecView] = useState<string | null>(null)
  const hosts = useSessionStore((s) => s.hosts)
  const aiSessions = useAiStore((s) => s.sessions)
  const chosen = items.filter((item) => selected.includes(item.connectionId))
  const close = async (): Promise<void> => {
    if (!pending || closing) return
    setClosing(true)
    try {
      const ids = pending.map((item) => item.connectionId)
      const { userClosed } = await window.aterm.hosts.closeConnections(hostId, ids)
      if (userClosed) useSessionStore.getState().detachHost(hostId)
      setSelected((prev) => prev.filter((id) => !ids.includes(id)))
      setPending(null)
    } catch (error) {
      onToast(errorMessage(error))
    } finally {
      setClosing(false)
    }
  }
  return (
    <section
      aria-label={t('conn.live.details', { name })}
      className="mx-3 my-2 overflow-hidden rounded-lg border border-line bg-surface/80"
    >
      {items.map((item) => (
        <div
          key={item.connectionId}
          className={`flex min-h-10 items-center gap-3 border-b border-line px-4 py-1 transition-colors duration-200 hover:bg-hover/60 ${selected.includes(item.connectionId) ? (item.owner === 'agent' ? 'bg-info/10' : 'bg-at-accent/10') : ''}`}
        >
          <input
            aria-label={item.connectionId}
            type="checkbox"
            className={`shrink-0 ${item.owner === 'agent' ? 'accent-(--at-info)' : 'accent-(--at-accent)'}`}
            checked={selected.includes(item.connectionId)}
            onChange={(e) =>
              setSelected((prev) =>
                e.target.checked
                  ? [...prev, item.connectionId]
                  : prev.filter((id) => id !== item.connectionId)
              )
            }
          />
          <span
            className={`flex w-20 shrink-0 items-center justify-center gap-1.5 rounded-md border py-1 text-minor ${item.owner === 'agent' ? 'border-info/40 bg-info/15 text-info' : 'border-at-accent/40 bg-at-accent/15 text-at-accent'}`}
          >
            {item.owner === 'agent' ? <Bot size={13} /> : <UserRound size={13} />}
            {t(`session.connection${item.owner === 'agent' ? 'Agent' : 'User'}`)}
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <span title={item.connectionId} className="truncate font-mono text-minor text-fg">
              {item.connectionId.length > 20
                ? `${item.connectionId.slice(0, 8)}…${item.connectionId.slice(-4)}`
                : item.connectionId}
            </span>
            <CopyIconButton value={item.connectionId} label={t('common.copy')} />
          </div>
          <span
            className="flex w-28 shrink-0 items-center gap-2 text-minor"
            style={{ color: linkStateDot(item.phase).color }}
          >
            <StateDot visual={linkStateDot(item.phase)} />
            {t(linkStateLabelKey(item.phase))}
          </span>
          <div className="min-w-0 flex-1 border-l border-line pl-4 text-minor text-muted">
            <div
              className="truncate"
              title={
                item.owner === 'user'
                  ? t('conn.live.userTerminal')
                  : aiSessions.find((s) => s.id === item.sessionId)?.title || item.sessionId
              }
            >
              {item.owner === 'user'
                ? t('conn.live.userTerminal')
                : aiSessions.find((s) => s.id === item.sessionId)?.title || item.sessionId}
            </div>
            <div className="text-caption">
              {t('conn.live.shells', { count: item.shellCount ?? 0 })}
            </div>
          </div>
          <Button
            size="sm"
            variant="text"
            title={t('common.close')}
            onClick={() => setPending([item])}
          />
          {/* agent 连接：查看该会话在此主机下的命令执行会话。
              其余行 invisible 占位（不可见不可点），保证 agent/用户行的列完全对齐 */}
          <IconButton
            icon={TerminalSquare}
            size={12}
            className={cn(!(item.owner === 'agent' && item.sessionId) && 'invisible')}
            disabled={!(item.owner === 'agent' && item.sessionId)}
            title={item.owner === 'agent' && item.sessionId ? t('execution.title') : undefined}
            onClick={() => {
              if (item.owner === 'agent' && item.sessionId) setExecView(item.sessionId)
            }}
          />
        </div>
      ))}
      {!items.length && <p className="px-4 py-3 text-minor text-muted">{t('conn.live.none')}</p>}
      <div className="flex items-center justify-between gap-3 bg-raised/40 px-4 py-2">
        <label className="flex items-center gap-3 text-minor text-fg">
          <input
            type="checkbox"
            className="accent-(--at-accent)"
            disabled={!items.length}
            checked={items.length > 0 && chosen.length === items.length}
            ref={(element) => {
              if (element) element.indeterminate = chosen.length > 0 && chosen.length < items.length
            }}
            onChange={(e) =>
              setSelected(e.target.checked ? items.map((item) => item.connectionId) : [])
            }
          />
          {t('conn.selectAll')}
          <span className="ml-3 text-muted">
            {t('conn.live.selected', { count: chosen.length })}
          </span>
        </label>
        <Button
          size="sm"
          variant="danger"
          disabled={!chosen.length}
          title={t('conn.live.closeSelected', { count: chosen.length })}
          onClick={() => setPending(chosen)}
        />
      </div>
      {pending && (
        <CloseDocumentsDialog
          closing={closing}
          documents={
            pending.some((item) => item.owner === 'user')
              ? hosts
                  .filter((host) => host.id === hostId)
                  .flatMap((host) =>
                    host.files
                      .filter((file) => file.text !== file.saved || file.saving)
                      .map((file) => ({ hostId, fileId: file.id, name: file.path }))
                  )
              : []
          }
          message={t('conn.live.confirm', { count: pending.length })}
          onCancel={() => setPending(null)}
          onClose={() => void close()}
        />
      )}
      {execView && (
        <Suspense fallback={null}>
          <ExecutionSessionsDialog
            sessionId={execView}
            hostId={hostId}
            onClose={() => setExecView(null)}
          />
        </Suspense>
      )}
    </section>
  )
}
