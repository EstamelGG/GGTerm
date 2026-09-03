import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/form/Buttons'
import { ChoiceChip } from '@/components/ui/ChoiceChip'
import { useLogStore } from '@/stores/logs'

/**
 * 日志面板（底部抽屉）：菜单栏 视图→日志面板 或 ⌘⇧L 呼出。
 * 打开时拉取主进程历史，新条目实时追加并自动滚底；按分类过滤、清空。
 * 展开高度可拖拽调节（上沿 splitter，20%–70%，localStorage 持久化）；
 * 折叠态收为底部单行（高度动画过渡），不遮挡画面。
 */

const HEADER_H = 36
/** 展开高度占父容器百分比（拖拽范围 20–70，默认 40） */
const H_KEY = 'ggterm.logHeightPct'
const PCT_MIN = 20
const PCT_MAX = 70

function loadPct(): number {
  const v = Number(localStorage.getItem(H_KEY))
  return Number.isFinite(v) ? Math.min(PCT_MAX, Math.max(PCT_MIN, v)) : 40
}

function fmtTime(t: number): string {
  const d = new Date(t)
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** 分类 → 颜色（新增分类默认 muted） */
const CATEGORY_CLS: Record<string, string> = {
  sftp: 'text-ok',
  ssh: 'text-at-warn',
  ai: 'text-info',
  safeguard: 'text-at-accent',
  app: 'text-muted'
}

/** 级别 → 标签与颜色（info 蓝 / warning 黄 / error 红；缺省视为 info） */
const LEVEL_CLS: Record<'info' | 'warning' | 'error', { tag: string; cls: string }> = {
  info: { tag: 'INFO', cls: 'text-info' },
  warning: { tag: 'WARN', cls: 'text-warn' },
  error: { tag: 'ERROR', cls: 'text-danger' }
}

export function LogDrawer(): React.JSX.Element | null {
  const { t } = useTranslation()
  const open = useLogStore((s) => s.open)
  const entries = useLogStore((s) => s.entries)
  const filter = useLogStore((s) => s.filter)
  const collapsed = useLogStore((s) => s.collapsed)
  const setFilter = useLogStore((s) => s.setFilter)
  const setOpen = useLogStore((s) => s.setOpen)
  const setCollapsed = useLogStore((s) => s.setCollapsed)
  const replaceAll = useLogStore((s) => s.replaceAll)
  const clear = useLogStore((s) => s.clear)

  const listRef = useRef<HTMLDivElement>(null)

  // 打开时拉取主进程历史
  useEffect(() => {
    if (!open) return
    void window.aterm.logs.list().then(replaceAll)
  }, [open, replaceAll])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  // 新条目自动滚底；用户正在框选文本时暂停（避免选中内容被滚走），选区消失即恢复
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) return
    el.scrollTop = el.scrollHeight
  }, [entries.length, open, filter, collapsed])

  const categories = useMemo(() => [...new Set(entries.map((e) => e.category))], [entries])
  const shown = useMemo(
    () => (filter === null ? entries : entries.filter((e) => e.category === filter)),
    [entries, filter]
  )

  // 展开高度拖拽（上沿 splitter；预览中不落盘，松手持久化）
  const [pct, setPct] = useState(loadPct)
  const [previewPct, setPreviewPct] = useState<number | null>(null)
  const dragOrigin = useRef<{ startY: number; startPct: number; containerH: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const dragging = previewPct !== null

  const beginDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    const rect = rootRef.current?.parentElement?.getBoundingClientRect()
    dragOrigin.current = {
      startY: e.clientY,
      startPct: previewPct ?? pct,
      containerH: Math.max(rect?.height ?? window.innerHeight, 1)
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const moveDrag = (e: React.PointerEvent): void => {
    const base = dragOrigin.current
    if (!base) return
    const dy = base.startY - e.clientY
    const next = (((base.startPct / 100) * base.containerH + dy) / base.containerH) * 100
    setPreviewPct(Math.min(PCT_MAX, Math.max(PCT_MIN, next)))
  }
  const endDrag = (): void => {
    if (previewPct !== null) {
      setPct(previewPct)
      localStorage.setItem(H_KEY, String(previewPct))
    }
    setPreviewPct(null)
    dragOrigin.current = null
  }

  if (!open) return null

  return (
    <div
      ref={rootRef}
      className={cn(
        'relative flex shrink-0 flex-col overflow-hidden border-t border-line bg-bg',
        dragging ? '' : 'transition-[height] duration-200 ease-out'
      )}
      style={{ height: collapsed ? HEADER_H : `${previewPct ?? pct}%` }}
    >
      {/* 上沿拖拽调高（展开态） */}
      {!collapsed && (
        <div
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none"
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
        />
      )}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <span className="text-caption font-semibold text-fg">{t('logs.title')}</span>
        <span className="w-8 shrink-0 text-right text-caption tabular-nums text-muted">
          {shown.length}
        </span>
        {!collapsed && (
          <>
            <div className="mx-2 h-4 w-px bg-line" />
            {[null, ...categories].map((value) => (
              <ChoiceChip
                key={value ?? '__all__'}
                selected={filter === value}
                className="px-2 py-[3px] text-caption"
                onClick={() => setFilter(value)}
              >
                {value ?? t('logs.filterAll')}
              </ChoiceChip>
            ))}
            <div className="flex-1" />
            <Button
              variant="text"
              title={t('logs.clear')}
              onClick={() => {
                window.aterm.logs.clear()
                clear()
              }}
            />
          </>
        )}
        {collapsed && <div className="flex-1" />}
        <IconButton
          icon={collapsed ? ChevronUp : ChevronDown}
          size={13}
          frame={24}
          aria-label={collapsed ? t('logs.expand') : t('logs.collapse')}
          onClick={() => setCollapsed(!collapsed)}
        />
        <IconButton
          icon={X}
          size={13}
          frame={24}
          aria-label={t('logs.closeEsc')}
          onClick={() => setOpen(false)}
        />
      </div>
      <div ref={listRef} className="min-h-0 flex-1 select-text overflow-y-auto px-3 py-2 font-mono">
        {shown.length === 0 ? (
          <p className="py-6 text-center text-minor text-muted/60">{t('logs.empty')}</p>
        ) : (
          shown.map((e, i) => {
            const lv = LEVEL_CLS[e.level ?? 'info']
            return (
              <div key={`${e.t}-${i}`} className="flex gap-2.5 py-[2px] text-caption leading-[1.5]">
                <span className="shrink-0 tabular-nums text-muted/60">{fmtTime(e.t)}</span>
                <span className={cn('w-9 shrink-0 font-medium', lv.cls)}>{lv.tag}</span>
                <span className={cn('shrink-0', CATEGORY_CLS[e.category] ?? 'text-muted')}>
                  [{e.category}]
                </span>
                <span className="min-w-0 flex-1 break-all text-fg/90">{e.message}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
