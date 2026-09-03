import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Ban, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSftpStore } from '@/stores/sftp'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/form/Buttons'
import { fmtSpeed } from '../format'
import type { SftpTransferMirror } from '@shared/types'

/**
 * 文件传输面板（活动栏，仅 SSH 会话页）：当前主机传输列表 + 进度条 + 取消。
 * 镜像数据全部来自 sftp store（事件驱动，无需拉取）。
 */

function statusLabelOf(
  t: (
    k: 'activity.transferDone' | 'activity.transferCanceled' | 'activity.transferFailed'
  ) => string,
  s: SftpTransferMirror['status']
): string {
  if (s === 'done') return t('activity.transferDone')
  if (s === 'canceled') return t('activity.transferCanceled')
  return t('activity.transferFailed')
}

function barColor(s: SftpTransferMirror['status']): string {
  if (s === 'error') return 'var(--at-danger)'
  if (s === 'canceled') return 'var(--at-muted)'
  if (s === 'done') return 'var(--at-ok)'
  return 'var(--at-info)'
}

function TransferRow({
  t,
  hostId,
  tr
}: {
  t: ReturnType<typeof useTranslation>['t']
  hostId: string
  tr: SftpTransferMirror
}): React.JSX.Element {
  const totalFiles = tr.totalFiles
  const fileBased = totalFiles !== undefined && totalFiles > 0
  const pct = fileBased
    ? Math.min(100, Math.floor(((tr.files ?? 0) / totalFiles) * 100))
    : tr.total > 0
      ? Math.min(100, Math.floor((tr.bytes / Math.max(tr.total, 1)) * 100))
      : null
  const running = tr.status === 'running'
  const canceling = running && tr.cancelRequested
  const accessFolder = tr.accessDenied?.folder

  return (
    <div className="flex flex-col gap-1.5 rounded-lg px-2 py-2 transition-colors hover:bg-hover/30">
      <div className="flex items-center gap-1.5">
        {tr.direction === 'up' ? (
          <ArrowUp size={10} strokeWidth={2.6} className="shrink-0 text-danger" />
        ) : (
          <ArrowDown size={10} strokeWidth={2.6} className="shrink-0 text-ok" />
        )}
        <span className="min-w-0 flex-1 truncate text-caption text-fg" title={tr.name}>
          {tr.name}
        </span>
        {running && !canceling && fileBased && (
          <span className="shrink-0 font-mono text-caption text-muted/75 animate-in fade-in duration-200">
            {t('activity.transferFiles', { done: tr.files ?? 0, total: totalFiles })}
          </span>
        )}
        {running && !canceling && tr.speed !== undefined && tr.speed > 0 && (
          <span className="shrink-0 font-mono text-caption text-muted/75 animate-in fade-in duration-200">
            {fmtSpeed(tr.speed)}
          </span>
        )}
        {canceling ? (
          <span role="status" className="flex shrink-0 items-center gap-1 text-caption text-muted">
            <Loader2 size={11} className="animate-spin" />
            {t('common.canceling')}
          </span>
        ) : running ? (
          <IconButton
            icon={X}
            size={11}
            frame={20}
            cornerRadius={5}
            aria-label={t('common.cancel')}
            onClick={() => window.aterm.sftp.cancelTransfer(hostId, tr.id)}
          />
        ) : (
          <span
            key={tr.status}
            role="status"
            className={cn(
              'flex shrink-0 items-center gap-1 text-caption animate-in fade-in duration-200',
              tr.status === 'error'
                ? 'text-danger'
                : tr.status === 'canceled'
                  ? 'rounded border border-line bg-raised px-1.5 py-0.5 text-fg'
                  : 'text-muted'
            )}
          >
            {tr.status === 'canceled' && <Ban size={11} className="text-muted" />}
            {statusLabelOf(t, tr.status)}
          </span>
        )}
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-hover/40">
        <div
          className="h-full rounded-full transition-[width] duration-150"
          style={{
            width: tr.status === 'done' ? '100%' : `${pct ?? (running ? 100 : 0)}%`,
            backgroundColor: barColor(canceling ? 'canceled' : tr.status),
            opacity: running && !canceling && pct === null ? 0.35 : 1
          }}
        />
      </div>
      {tr.status === 'error' && tr.error && (
        <div className="flex flex-col gap-1">
          <span role="alert" className="break-all whitespace-pre-wrap text-caption text-danger/85">
            {tr.error}
          </span>
          {accessFolder && (
            <Button
              variant="text"
              title={t('activity.transferAccessDeniedAction')}
              onClick={() => void window.aterm.localAccess.openPrivacySettings(accessFolder)}
            />
          )}
        </div>
      )}
      {running && tr.phase === 'extracting' && !canceling && (
        <span className="text-caption text-muted">{t('activity.transferExtracting')}</span>
      )}
      {tr.cleanup === 'pending' && (
        <span role="status" className="text-caption text-muted">
          {t('activity.transferCleaning')}
        </span>
      )}
      {tr.cleanup === 'error' && (
        <div className="flex flex-col gap-1">
          <span role="alert" className="break-all text-caption text-danger">
            {t('activity.transferCleanupFailed')}: {tr.cleanupError}
          </span>
          <Button
            variant="text"
            title={t('common.retry')}
            onClick={() => window.aterm.sftp.retryCleanup(hostId, tr.id)}
          />
        </div>
      )}
    </div>
  )
}

export function TransfersPanel({ hostId }: { hostId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const transfers = useSftpStore((s) => s.panes[hostId]?.transfers ?? [])
  const clearFinished = useSftpStore((s) => s.clearFinished)
  const hasFinished = transfers.some((tr) => tr.status !== 'running')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          variant="text"
          title={t('activity.transfersClear')}
          disabled={!hasFinished}
          onClick={() => clearFinished(hostId)}
        />
        <div className="flex-1" />
        <Button
          variant="text"
          title={t('activity.transfersOpen')}
          onClick={() => window.aterm.sftp.revealDownloads()}
        />
      </div>
      {transfers.length === 0 ? (
        <p className="py-8 text-center text-minor text-muted/60">{t('activity.transfersEmpty')}</p>
      ) : (
        <div className="flex flex-col">
          {transfers.map((tr) => (
            <TransferRow key={tr.id} t={t} hostId={hostId} tr={tr} />
          ))}
        </div>
      )}
    </div>
  )
}
