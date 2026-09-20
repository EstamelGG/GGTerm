import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownUp, Bot, Gauge, Zap } from 'lucide-react'
import { useResizePreview } from '@/lib/useResizePreview'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/IconButton'
import { useSftpStore } from '@/stores/sftp'
import { useSessionStore } from '@/stores/session'
import { useWorkspaceStore, type ActivityPanelId } from '@/stores/workspace'
import { isBusy, pendingApprovals, useAiStore } from '@/stores/ai'
import { useHumanInputStore } from '@/stores/humanInput'
import { PerformancePanel } from './panels/PerformancePanel'
import { TransfersPanel } from './panels/TransfersPanel'
import { CommandsPanel } from './panels/CommandsPanel'

const AiWorkspacePage = lazy(() => import('@/pages/AiWorkspacePage'))
const WIDTH_KEY = 'ggterm.activityDockWidth'
const MIN_WIDTH = 300
const MAX_WIDTH = 720

function loadWidth(): number {
  const raw = localStorage.getItem(WIDTH_KEY)
  const value = raw === null ? NaN : Number(raw)
  return Number.isFinite(value) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value)) : 460
}

const PANELS = [
  { id: 'ai', icon: Bot, titleKey: 'ai.title' },
  { id: 'performance', icon: Gauge, titleKey: 'activity.performance' },
  { id: 'transfers', icon: ArrowDownUp, titleKey: 'activity.transfers' },
  { id: 'commands', icon: Zap, titleKey: 'activity.commands' }
] as const

/** 全局右栏：AI 常驻；性能与快捷命令跟随最近进入的 shell 主机，传输跨主机汇总。 */
export function ActivityRail(): React.JSX.Element {
  const { t } = useTranslation()
  const active = useWorkspaceStore((s) => s.activePanel)
  const open = useWorkspaceStore((s) => s.sidebarOpen)
  const focusedId = useWorkspaceStore((s) => s.focusedHostId)
  const host = useSessionStore((s) => s.hosts.find((h) => h.id === focusedId))
  const hostId = host?.id ?? null
  const [width, setWidth] = useState(loadWidth)
  const previewRef = useRef<HTMLDivElement>(null)
  const transfersRunning = useSftpStore((s) =>
    Object.values(s.panes).some((p) => p.transfers.some((x) => x.status === 'running'))
  )
  const aiBusy = useAiStore((s) => s.sessions.some(isBusy))
  const aiApproval = useAiStore((s) =>
    s.sessions.some((session) => pendingApprovals(session.messages).length > 0)
  )
  const aiInput = useHumanInputStore((s) => Object.keys(s.pending).length > 0)

  useEffect(() => {
    window.aterm.perf.watchSession(hostId)
    return () => window.aterm.perf.watchSession(null)
  }, [hostId])

  const resize = useResizePreview({
    value: width,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    direction: -1,
    onCommit: (next) => {
      setWidth(next)
      localStorage.setItem(WIDTH_KEY, String(next))
    },
    onPreview: (next) => {
      if (previewRef.current) previewRef.current.style.transform = `translateX(${width - next}px)`
    }
  })
  const select = (panel: ActivityPanelId): void => {
    const state = useWorkspaceStore.getState()
    if (open && active === panel) state.setSidebarOpen(false)
    else state.selectPanel(panel)
  }

  return (
    <aside className="relative flex h-full shrink-0" aria-label={t('activity.sidebar')}>
      {resize.preview !== null && (
        <div
          ref={previewRef}
          className="pointer-events-none absolute inset-y-0 left-0 z-20 w-0.5 bg-at-accent/85"
        />
      )}
      <div
        className={cn(
          'relative h-full shrink-0 overflow-hidden border-l border-line bg-surface',
          !open && 'hidden'
        )}
        style={{ width, maxWidth: '50vw' }}
      >
        <div
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none"
          {...resize.handleProps}
        />
        {/* AI 始终挂载，切换面板与折叠保留输入草稿、滚动位置和对话状态。 */}
        <div className={cn('h-full', active !== 'ai' && 'hidden')}>
          <Suspense fallback={null}>
            <AiWorkspacePage />
          </Suspense>
        </div>
        {active !== 'ai' && (
          <div className="flex h-full min-w-0 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
              <span className="shrink-0 text-caption font-semibold text-fg">
                {t(PANELS.find((p) => p.id === active)!.titleKey)}
              </span>
              {active !== 'transfers' && host && (
                <span
                  className="min-w-0 truncate text-caption text-muted"
                  title={`${host.conn.username}@${host.conn.host}:${host.conn.port}`}
                >
                  {host.title}
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {active === 'transfers' ? (
                <TransfersPanel />
              ) : hostId ? (
                active === 'performance' ? (
                  <PerformancePanel key={hostId} hostId={hostId} />
                ) : (
                  <CommandsPanel hostId={hostId} />
                )
              ) : (
                <p className="py-8 text-center text-minor text-muted">
                  {t('activity.noFocusedHost')}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="flex w-10 shrink-0 flex-col items-center gap-1.5 border-l border-line bg-sidebar py-3">
        {PANELS.map((panel) => (
          <span key={panel.id} className="relative">
            <IconButton
              variant="toolbar"
              icon={panel.icon}
              size={14}
              title={t(panel.titleKey)}
              selected={open && active === panel.id}
              aria-pressed={open && active === panel.id}
              onClick={() => select(panel.id)}
            />
            {((panel.id === 'transfers' && transfersRunning) ||
              (panel.id === 'ai' && (aiBusy || aiApproval || aiInput))) && (
              <span
                className={cn(
                  'pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full',
                  panel.id === 'ai' && (aiApproval || aiInput) ? 'bg-danger' : 'bg-at-accent'
                )}
              />
            )}
          </span>
        ))}
      </div>
    </aside>
  )
}
