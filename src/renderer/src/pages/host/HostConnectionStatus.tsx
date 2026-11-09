import { TerminalPane } from '@/components/terminal/TerminalPane'
import { WorkspacePane } from '@/components/terminal/WorkspacePane'
import { Button } from '@/components/form/Buttons'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { linkStateColor } from '@/lib/linkPhase'
import { cn } from '@/lib/utils'
import { type HostWorkspaceMirror } from '@/stores/session'
import type { ShellStatus } from '@shared/types'
import { MAX_RECONNECTS } from '@shared/connectionState'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
const PHASE_LABELS = {
  connected: 'session.statusConnected',
  reconnecting: 'session.statusReconnecting',
  offline: 'session.statusDisconnected',
  idle: 'session.statusDisconnected',
  connecting: 'session.statusConnecting'
} as const

export function ShellPane({
  host,
  shell,
  focused
}: {
  host: HostWorkspaceMirror
  shell: { id: string; number: number; status: ShellStatus; error?: string }
  focused: boolean
}): React.JSX.Element {
  return (
    <div className={cn('absolute inset-0', focused ? '' : 'pointer-events-none opacity-0')}>
      <WorkspacePane
        overlay={
          focused && shell.status === 'error' && shell.error ? (
            <div className="absolute inset-x-0 top-0 flex justify-center pt-5 animate-in fade-in duration-200">
              <span
                role="alert"
                className="glass max-h-32 max-w-[80%] overflow-auto whitespace-pre-wrap break-words rounded-[var(--at-panel-radius)] px-3 py-2 text-minor text-fg select-text"
              >
                {shell.error}
              </span>
            </div>
          ) : undefined
        }
      >
        <TerminalPane instanceKey={`${host.id}:${shell.id}`} />
      </WorkspacePane>
    </div>
  )
}

/** 对照 LinkStatusPill：状态点 + label，点击弹心跳诊断 */
export function LinkStatusPill({ host }: { host: HostWorkspaceMirror }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const interval = host.conn.keepaliveInterval

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center gap-[5px] rounded-md px-2 py-[3px] text-muted outline-none transition-colors duration-100 hover:bg-hover/70 hover:text-fg focus-visible:ring-1 focus-visible:ring-at-accent',
            open && 'bg-at-accent/15 text-fg'
          )}
        >
          <span
            className="h-1.5 w-1.5 rounded-full transition-colors duration-300"
            style={{ backgroundColor: linkStateColor(host.phase) }}
          />
          <span
            key={host.phase}
            className="text-caption animate-in fade-in slide-in-from-bottom-1 duration-200"
          >
            {t(PHASE_LABELS[host.phase], { attempt: host.attempt, total: MAX_RECONNECTS })}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-72">
        <div className="flex items-center gap-1.5">
          <span
            className="h-1.5 w-1.5 rounded-full transition-colors duration-300"
            style={{ backgroundColor: linkStateColor(host.phase) }}
          />
          <span
            key={host.phase}
            className="text-minor font-semibold text-fg animate-in fade-in slide-in-from-bottom-1 duration-200"
          >
            {t(PHASE_LABELS[host.phase], { attempt: host.attempt, total: MAX_RECONNECTS })}
          </span>
        </div>
        <div className="mt-2 flex flex-col gap-[5px]">
          <InfoRow
            title={t('session.keepaliveInterval')}
            value={interval > 0 ? `${interval} ms` : t('common.close')}
          />
          <InfoRow title={t('session.lossThreshold')} value={t('session.times', { n: 3 })} />
          {host.phase === 'offline' && host.offlineReason && (
            <InfoRow title={t('session.offlineReason')} value={host.offlineReason} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function InfoRow({ title, value }: { title: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <span className="shrink-0 text-minor text-muted">{title}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-right font-mono text-minor text-fg select-text">
        {value}
      </span>
    </div>
  )
}

/** Uses layout space so recovery messages never cover terminal output. */
export function HostRecoveryBanner({
  host,
  onReconnect
}: {
  host: HostWorkspaceMirror
  onReconnect: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (host.viewerOnly || host.awaiting || host.phase === 'connected') return null
  const busy = host.phase === 'connecting' || host.phase === 'reconnecting'
  return (
    <div className="shrink-0 border-b border-line bg-sidebar px-3 py-2" data-testid="host-recovery">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p role="status" className="min-w-0 flex-1 text-minor text-fg">
          {t(PHASE_LABELS[host.phase], { attempt: host.attempt, total: MAX_RECONNECTS })}
          {host.phase === 'reconnecting' && (
            <span className="ml-2 text-muted">{t('session.recoveryHint')}</span>
          )}
        </p>
        <Button
          variant="text"
          title={t(busy ? 'session.cancelConnect' : 'session.reconnect')}
          onClick={busy ? () => window.aterm.hosts.cancelConnect(host.id) : onReconnect}
        />
      </div>
      {host.phase === 'offline' && host.offlineReason && (
        <details className="mt-1 text-minor text-muted">
          <summary className="w-fit cursor-pointer">{t('session.offlineReason')}</summary>
          <p className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-danger select-text">
            {host.offlineReason}
          </p>
        </details>
      )}
    </div>
  )
}
