import { TerminalPane } from '@/components/terminal/TerminalPane'
import { WorkspacePane } from '@/components/terminal/WorkspacePane'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { linkStateColor } from '@/lib/linkPhase'
import { cn } from '@/lib/utils'
import { type HostWorkspaceMirror } from '@/stores/session'
import type { LinkPhase, ShellStatus } from '@shared/types'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
/** 链路状态 → i18n key（渲染处 t() 插值，保证切语言实时生效） */
function phaseLabelKey(
  phase: LinkPhase
):
  | 'session.statusConnected'
  | 'session.statusReconnecting'
  | 'session.statusDisconnected'
  | 'session.statusConnecting' {
  switch (phase) {
    case 'connected':
      return 'session.statusConnected'
    case 'reconnecting':
      return 'session.statusReconnecting'
    // offline = 重试超限失败；idle = 链路被断开（含 AI 主动断开，可重连恢复）
    case 'offline':
    case 'idle':
      return 'session.statusDisconnected'
    default:
      return 'session.statusConnecting'
  }
}

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
              <span className="glass max-w-[80%] truncate rounded-full px-2.5 py-[5px] text-caption font-medium text-fg">
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
  const [hovering, setHovering] = useState(false)
  const [open, setOpen] = useState(false)
  const interval = host.conn.keepaliveInterval

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center gap-[5px] rounded-md border px-2 py-[3px] transition-colors duration-100',
            open
              ? 'border-at-accent/55 bg-at-accent/15'
              : hovering
                ? 'border-line bg-hover/70'
                : 'border-line bg-raised/45',
            open || hovering ? 'text-fg' : 'text-muted'
          )}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
        >
          <span
            className="h-1.5 w-1.5 rounded-full transition-colors duration-300"
            style={{ backgroundColor: linkStateColor(host.phase) }}
          />
          <span
            key={host.phase}
            className="text-caption animate-in fade-in slide-in-from-bottom-1 duration-200"
          >
            {t(phaseLabelKey(host.phase), { attempt: host.attempt, total: 3 })}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-64 border-line p-3.5">
        <div className="flex items-center gap-1.5">
          <span
            className="h-1.5 w-1.5 rounded-full transition-colors duration-300"
            style={{ backgroundColor: linkStateColor(host.phase) }}
          />
          <span
            key={host.phase}
            className="text-minor font-semibold text-fg animate-in fade-in slide-in-from-bottom-1 duration-200"
          >
            {t(phaseLabelKey(host.phase), { attempt: host.attempt, total: 3 })}
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
      <span className="text-caption text-muted">{title}</span>
      <span className="min-w-0 flex-1 truncate text-right font-mono text-caption text-fg">
        {value}
      </span>
    </div>
  )
}
