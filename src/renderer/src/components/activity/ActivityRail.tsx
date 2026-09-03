import { useResizePreview } from '@/lib/useResizePreview'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownUp, Gauge, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/IconButton'
import { useSftpStore } from '@/stores/sftp'
import { PerformancePanel } from './panels/PerformancePanel'
import { TransfersPanel } from './panels/TransfersPanel'
import { CommandsPanel } from './panels/CommandsPanel'

/**
 * 会话区右侧活动栏（对照 VS Code Activity Bar，仅 SSH 会话页）：
 * 窄条图标栏常驻，点击图标在栏左展开 dock 面板（同一时间至多一个，再点收起，无独立关闭钮）。
 * dock 为贴边全高矩形（无圆角、与图标栏无缝相连，左缘 border-line 与终端区分隔）；
 * 宽度全部面板共享、可拖拽（240–480）、localStorage 持久化。
 * 性能/传输面板按传入 hostId 过滤当前主机。
 */

/** dock 宽度（px）：全页面共享（读 localStorage），拖拽范围 240–480，默认 300 */
const WIDTH_KEY = 'ggterm.activityDockWidth'
const MIN_WIDTH = 240
const MAX_WIDTH = 480

function loadWidth(): number {
  const raw = localStorage.getItem(WIDTH_KEY)
  const v = raw === null ? NaN : Number(raw)
  return Number.isFinite(v) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v)) : 300
}

export type ActivityPanelId = 'performance' | 'transfers' | 'commands'

/** i18n 标题键（字面量联合，保证 t() 键类型校验通过） */
type ActivityTitleKey = 'activity.performance' | 'activity.transfers' | 'activity.commands'

interface ActivityPanelDef {
  id: ActivityPanelId
  icon: LucideIcon
  titleKey: ActivityTitleKey
}

const PANELS: ActivityPanelDef[] = [
  { id: 'performance', icon: Gauge, titleKey: 'activity.performance' },
  { id: 'transfers', icon: ArrowDownUp, titleKey: 'activity.transfers' },
  { id: 'commands', icon: Zap, titleKey: 'activity.commands' }
]

export function ActivityRail({
  hostId,
  maxWidth = MAX_WIDTH,
  onWidthChange
}: {
  hostId: string
  maxWidth?: number
  onWidthChange?: (width: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [active, setActive] = useState<ActivityPanelId | null>(null)
  const [width, setWidth] = useState(() => loadWidth())
  const previewRef = useRef<HTMLDivElement>(null)
  /** 传输中徽标：任一主机存在 running 传输即点亮（跨面板常驻提醒） */
  const transfersRunning = useSftpStore((s) =>
    Object.values(s.panes).some((p) => p.transfers.some((x) => x.status === 'running'))
  )

  // 会话页打开即持续采样（独立通道，借用会话共享连接）；切换 dock 面板不卸载本组件，历史得以延续
  useEffect(() => {
    window.aterm.perf.watchSession(hostId)
    return () => window.aterm.perf.watchSession(null)
  }, [hostId])

  const panel = PANELS.find((p) => p.id === active)
  const effectiveWidth = Math.min(width, maxWidth)
  useEffect(() => {
    onWidthChange?.(panel ? effectiveWidth : 0)
  }, [panel, effectiveWidth, onWidthChange])

  const resize = useResizePreview({
    value: effectiveWidth,
    min: MIN_WIDTH,
    max: Math.min(MAX_WIDTH, maxWidth),
    direction: -1,
    onCommit: (next) => {
      setWidth(next)
      localStorage.setItem(WIDTH_KEY, String(next))
    },
    onPreview: (next) => {
      if (previewRef.current)
        previewRef.current.style.transform = `translateX(${effectiveWidth - next}px)`
    }
  })
  const dragging = resize.preview !== null

  return (
    <div className="relative flex h-full shrink-0">
      {dragging && (
        <div
          ref={previewRef}
          className="pointer-events-none absolute inset-y-0 left-0 z-20 w-0.5 bg-at-accent/85"
        />
      )}
      {/* dock：贴边全高矩形面板，左缘 border-line 与终端区分隔；宽度三面板共享。
          外层常驻、width 0↔N 过渡（拖拽调宽时豁免 transition 防预览滞后）；
          内层卡片定宽，展开/收起由外层 overflow 裁切推进（reveal 效果） */}
      <div
        className="relative h-full shrink-0 overflow-hidden"
        style={{ width: panel ? effectiveWidth : 0 }}
      >
        {panel && (
          <>
            {/* 左缘拖拽调宽（把手贴内侧，外层裁切下不可越界；拖拽中显示 accent 预览线） */}
            <div
              className="absolute inset-y-0 left-0 z-10 w-2.5 cursor-col-resize touch-none"
              {...resize.handleProps}
            />
            <div
              className="flex h-full flex-col overflow-hidden border-l border-line bg-surface"
              style={{ width: effectiveWidth }}
            >
              <div className="flex h-9 shrink-0 items-center border-b border-line px-3">
                <span className="text-caption font-semibold text-fg">{t(panel.titleKey)}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {panel.id === 'performance' && <PerformancePanel hostId={hostId} />}
                {panel.id === 'transfers' && <TransfersPanel hostId={hostId} />}
                {panel.id === 'commands' && <CommandsPanel hostId={hostId} />}
              </div>
            </div>
          </>
        )}
      </div>

      {/* 活动栏：窄条图标列，常驻右侧 */}
      <div className="flex w-10 shrink-0 flex-col items-center gap-1.5 border-l border-line bg-sidebar py-3">
        {PANELS.map((p) => (
          <span key={p.id} className="relative">
            <IconButton
              variant="toolbar"
              icon={p.icon}
              size={14}
              title={t(p.titleKey)}
              selected={active === p.id}
              onClick={() => setActive(active === p.id ? null : p.id)}
            />
            {p.id === 'transfers' && transfersRunning && (
              <span
                className={cn(
                  'absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-at-accent transition-opacity duration-150',
                  active === 'transfers' ? 'opacity-0' : 'opacity-100'
                )}
              />
            )}
          </span>
        ))}
      </div>
    </div>
  )
}
