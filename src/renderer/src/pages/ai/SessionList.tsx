import { IconButton } from '@/components/ui/IconButton'
import { StateDot } from '@/components/ui/StateDot'
import { solidDot } from '@/lib/linkPhase'
import { cn } from '@/lib/utils'
import { isBusy, pendingApprovals, sessionTitle, type AiSession } from '@/stores/ai'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** 会话列表时间：M/D HH:mm（紧凑、数字本地化无关） */
function fmtListTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 会话列表（VS Code Copilot 风格历史）：按最近活动排序，点击进入；状态点 = 待审批(黄)/生成中(蓝)；行尾删除 */
export function SessionList({
  sessions,
  activeId,
  onOpen,
  onClose
}: {
  sessions: AiSession[]
  activeId: string | null
  onOpen: (id: string) => void
  onClose: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
      {sorted.map((s) => (
        <div
          key={s.id}
          role="button"
          tabIndex={0}
          aria-pressed={s.id === activeId}
          onClick={() => onOpen(s.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onOpen(s.id)
          }}
          className={cn(
            'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-at-accent',
            s.id === activeId && 'bg-hover/60'
          )}
        >
          <span className="flex w-2 shrink-0 justify-center">
            {pendingApprovals(s.messages).length > 0 ? (
              <StateDot visual={solidDot('var(--at-warn)')} />
            ) : isBusy(s) ? (
              <StateDot visual={solidDot('var(--at-accent)')} />
            ) : null}
          </span>
          <span className="min-w-0 flex-1 truncate text-minor text-fg">{sessionTitle(s)}</span>
          <span className="shrink-0 text-caption text-muted">{fmtListTime(s.updatedAt)}</span>
          <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <IconButton
              icon={X}
              size={11}
              frame={22}
              aria-label={t('common.close')}
              onClick={(e) => {
                e.stopPropagation()
                onClose(s.id)
              }}
            />
          </span>
        </div>
      ))}
    </div>
  )
}
