import { DEVICE_TYPES, isNetworkDevice } from '@shared/device'
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUpDown,
  Bot,
  ChevronDown,
  ChevronUp,
  Ellipsis,
  Link2,
  Pencil,
  RotateCw,
  UserRound
} from 'lucide-react'
import type { HostConnection, SshConnectionSession } from '@shared/types'
import { cn } from '@/lib/utils'
import { useResizePreview } from '@/lib/useResizePreview'
import { useLatencyStore, type LatencyStatus } from '@/stores/latency'
import { useLinksStore } from '@/stores/links'
import { usePerfStore } from '@/stores/perf'
import { Button } from '@/components/form/Buttons'
import { CheckBox } from '@/components/form/Fields'
import { IconButton } from '@/components/ui/IconButton'
import {
  HOST_MIN_WIDTH,
  LIVE_WIDTH,
  loadPreferred,
  persistPreferred,
  resolveHostWidth
} from './columnWidths'
import { ExpandableTextCell, HostAddressCell, LatencyCell, PerfCell } from './cells'
import { linkStateColor, linkStateLabelKey } from '@/lib/linkPhase'
import { NoteEditorDialog, NoteIconButton } from './NoteEditorDialog'
import { noteHasContent } from '@shared/serverNote'
import { OsIcon } from './OsIcon'
import { useConnectionSessions } from './useConnectionSessions'
import { ConnectionSessionsDetail } from './ConnectionSessionsDetail'
import { RevealRow } from '@/components/chrome/RevealRow'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

const H_INSET = 16
/** 复选框列（固定宽，不可拖拽调整，不参与列宽挤压分配） */
const CHECKBOX_WIDTH = 28
/** 为中英文连接按钮、两枚图标钮及间距预留空间，避免按钮挤入性能列。 */
const ACTION_WIDTH = 160
/** 行持续可见满 3s 才开始刷新性能/延迟；离开视口停止刷新（已载数据保留不卸载） */
const SETTLE_MS = 3000
/** 行步进高度（h-[72px] 含 border-b）：虚拟滚动按此计算窗口 */
const ROW_STRIDE = 72
/** 虚拟滚动上下额外渲染的行数 */
const OVERSCAN = 6

/** 行级订阅兜底：无会话主机共用同一空数组引用（保持 HostRow memo 命中） */
const EMPTY_ITEMS: SshConnectionSession[] = []

/** 列宽拖拽会话（仅主机列）：base = 拖拽起始渲染宽快照，target = 指针目标宽 */
interface DragSession {
  base: number
  target: number
}

export type SortColumn = 'createdAt' | 'name' | 'host' | 'username' | 'latency'

/**
 * 对照 ConnectionPage.swift：表格主体。
 * 虚拟滚动（固定行步进 + 展开行实测高度）只渲染视口窗口；行组件 memo 化并各自
 * 订阅自己的性能/延迟/链路数据 —— 单主机更新只重渲染那一行，不再全表风暴。
 * 列宽自管：仅主机列可拖宽（resolveHostWidth 钳制 + useResizePreview 手柄），
 * 连接列定宽，延迟/性能区（flex）吸收剩余空间。
 */
export function ConnectionTable({
  active,
  perfEnabled,
  connections,
  sortColumn,
  sortAscending,
  onToggleSort,
  onConnect,
  onEdit,
  onDuplicate,
  onDelete,
  onToast,
  onLocate,
  reveal,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll
}: {
  /** 页面是否激活（常驻挂载下由 tab 决定；小列表模式下驱动性能探测启停） */
  active: boolean
  /** 全局性能监控开关；关闭时指标区仅保留延迟。 */
  perfEnabled: boolean
  connections: HostConnection[]
  sortColumn: SortColumn
  sortAscending: boolean
  onToggleSort: (col: Exclude<SortColumn, 'createdAt'>) => void
  onConnect: (c: HostConnection) => void
  onEdit: (c: HostConnection) => void
  /** 复制连接（数据全同，名称加 " - Copy" 后缀） */
  onDuplicate: (c: HostConnection) => void
  onDelete: (c: HostConnection) => void
  onToast: (text: string) => void
  /** 点击主机名 → 左侧目录定位该主机 */
  onLocate: (c: HostConnection) => void
  reveal?: { id: string; n: number } | null
  /** 多选状态（父层持有；导出/删除按钮在工具栏） */
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  /** 全选/取消全选（作用域 = 当前可见行） */
  onToggleSelectAll: (next: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // preferred 主机列宽（localStorage 恢复；拖拽结束时覆写为最终渲染宽，所见即所存）
  const [preferred, setPreferred] = useState<number>(() => loadPreferred())
  // 拖拽会话：ref 供事件处理器同步读写（pointermove 可能先于重渲染到达），state 驱动 pinned 布局
  const [drag, setDrag] = useState<DragSession | null>(null)
  const dragRef = useRef<DragSession | null>(null)
  const [tableWidth, setTableWidth] = useState(800)
  const containerRef = useRef<HTMLDivElement>(null)

  const refreshLatency = useLatencyStore((s) => s.refresh)
  /** 链路相位（全局镜像，主进程为权威）：状态列数据源已下沉到行内订阅 */

  useLayoutEffect(() => {
    if (!active) return
    const el = containerRef.current
    if (!el) return
    // 恢复显示后、浏览器绘制前同步测量；不能等 RO 回调才修正上一页留下的宽度。
    // 隐藏挂载或 Suspense 隐藏时的 0 宽不作为有效布局，保留最后一次测量。
    const measure = (): void => {
      const width = el.clientWidth
      if (width > 0) setTableWidth(width)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [active])

  /* ---------------- 会话快照（1s 轮询；hook 内内容去重，无变化不触发重渲染） ---------------- */
  const allIds = useMemo(() => connections.map((c) => c.id), [connections])
  const connectionSessions = useConnectionSessions(active, allIds)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  /** 收起动画期间保持挂载的行 id：过渡（200ms）结束后再卸载面板 */
  const [closingId, setClosingId] = useState<string | null>(null)
  // 收起动画窗口：与 RevealRow 的 200ms 过渡对齐，结束后卸载面板
  useEffect(() => {
    if (!closingId) return
    const timer = setTimeout(() => setClosingId(null), 200)
    return () => clearTimeout(timer)
  }, [closingId])

  /** 展开/收起行内明细；直接切换目标行时，旧行进入收起动画（依赖 expandedId：展开态低频变化） */
  const toggleExpanded = useCallback(
    (id: string): void => {
      if (expandedId === id) {
        setExpandedId(null)
        setClosingId(id)
      } else {
        if (expandedId) setClosingId(expandedId)
        setExpandedId(id)
      }
    },
    [expandedId]
  )

  const sessionsByHost = useMemo(() => {
    const grouped = new Map<string, SshConnectionSession[]>()
    for (const item of connectionSessions.items)
      grouped.set(item.hostId, [...(grouped.get(item.hostId) ?? []), item])
    return grouped
  }, [connectionSessions])

  // 渲染期调整：展开中的主机连接清零（全部被关闭）时立即收起（进入收起动画）；
  // 加载中不判 —— 0 只代表还没到数据，不代表没有连接
  if (
    expandedId &&
    !connectionSessions.loading &&
    (sessionsByHost.get(expandedId)?.length ?? 0) === 0
  ) {
    setClosingId(expandedId)
    setExpandedId(null)
  }

  /* ---------------- 视口可见性驱动（IntersectionObserver → 3s 稳定 → perf:watch / 延迟探测） ---------------- */

  const scrollRef = useRef<HTMLDivElement>(null)
  const ioRef = useRef<IntersectionObserver | null>(null)
  const rowEls = useRef(new Map<string, HTMLElement>())
  const visibleRef = useRef(new Set<string>())
  /** 可见→刷新的稳定窗口：持续可见满 3s 才进入稳定集（快速滚过不触发） */
  const settleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const settledRef = useRef(new Set<string>())
  const [settledIds, setSettledIds] = useState<string[]>([])
  const settledSet = useMemo(() => new Set(settledIds), [settledIds])
  /** 主机名称旁的备注入口。 */
  const [noteTarget, setNoteTarget] = useState<HostConnection | null>(null)
  /** 跳板链高亮：点击主机行的链条按钮后，3 秒内框出其跳板主机所在行 */
  const [jumpHighlight, setJumpHighlight] = useState<{ ids: string[] } | null>(null)
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const syncSettled = useCallback((): void => {
    setSettledIds([...settledRef.current])
  }, [])

  // 最新列表镜像：稳定回调内按 id 取主机地址用（不作为 effect 依赖）
  const connectionsRef = useRef(connections)
  connectionsRef.current = connections
  /** 每台主机独立的延迟探测周期（10s）：独立开始、独立刷新、结果逐台上屏 */
  const latencyTimers = useRef(new Map<string, ReturnType<typeof setInterval>>())
  const startLatencyCycle = useCallback(
    (conn: HostConnection): void => {
      if (conn.jumpHostIds?.length) return // 跳板主机在内网，直连探测无意义
      if (latencyTimers.current.has(conn.id)) return
      const probe = (): void => refreshLatency([{ id: conn.id, host: conn.host, port: conn.port }])
      probe()
      latencyTimers.current.set(conn.id, setInterval(probe, 10_000))
    },
    [refreshLatency]
  )
  /** 停止某台的延迟刷新（离开视口/被移除；已载数据保留） */
  const stopLatencyCycle = useCallback((id: string): void => {
    const timer = latencyTimers.current.get(id)
    if (timer) {
      clearInterval(timer)
      latencyTimers.current.delete(id)
    }
  }, [])

  // 高亮 3 秒后自动清除；再次点击重置计时。目标行可能被虚拟化卸载：回退为按偏移滚动定位
  const flashJumpHosts = useCallback(
    (ids: string[]): void => {
      setJumpHighlight({ ids })
      if (jumpTimer.current) clearTimeout(jumpTimer.current)
      jumpTimer.current = setTimeout(() => setJumpHighlight(null), 3000)
      const el = rowEls.current.get(ids[0])
      if (el) {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        return
      }
      const idx = connections.findIndex((c) => c.id === ids[0])
      if (idx >= 0)
        scrollRef.current?.scrollTo({
          top: Math.max(0, idx * ROW_STRIDE - (scrollRef.current.clientHeight - ROW_STRIDE) / 2),
          behavior: 'smooth'
        })
    },
    [connections]
  )
  useEffect(
    () => () => {
      if (jumpTimer.current) clearTimeout(jumpTimer.current)
    },
    []
  )

  // IO 挂滚动容器：行进出视口驱动加载/卸载（严格视口内才算可见；可见满 SETTLE_MS 才进入稳定集）
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const io = new IntersectionObserver(
      (records) => {
        for (const r of records) {
          const id = (r.target as HTMLElement).dataset.hostId
          if (!id) continue
          if (r.isIntersecting) {
            if (visibleRef.current.has(id)) continue
            visibleRef.current.add(id)
            settleTimers.current.set(
              id,
              setTimeout(() => {
                settleTimers.current.delete(id)
                if (!settledRef.current.has(id)) {
                  settledRef.current.add(id)
                  syncSettled()
                  // 该主机独立开始延迟探测周期（性能由 perf watch 按 diff 独立启停）
                  const conn = connectionsRef.current.find((c) => c.id === id)
                  if (conn) startLatencyCycle(conn)
                }
              }, SETTLE_MS)
            )
          } else if (visibleRef.current.delete(id)) {
            const timer = settleTimers.current.get(id)
            if (timer) {
              clearTimeout(timer)
              settleTimers.current.delete(id)
            }
            if (settledRef.current.delete(id)) syncSettled()
            stopLatencyCycle(id)
          }
        }
      },
      { root, rootMargin: '0px', threshold: 0 }
    )
    ioRef.current = io
    return () => {
      io.disconnect()
      ioRef.current = null
    }
  }, [syncSettled, startLatencyCycle, stopLatencyCycle])

  // 行集合变化（过滤/搜索/删除/虚拟窗口滚动）→ 重挂观察目标；被移除的行同步清出可见/稳定集。
  // 无条件 observe：同一 observer 上重复 observe 是 no-op；StrictMode 双挂载会
  // disconnect 旧 IO 并新建，跳过优化会导致新 IO 永远没有目标（监控消失）
  useEffect(() => {
    const root = scrollRef.current
    const io = ioRef.current
    if (!root || !io) return
    const known = rowEls.current
    const present = new Set<string>()
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-host-id]'))) {
      const id = el.dataset.hostId
      if (!id || present.has(id)) continue
      present.add(id)
      known.set(id, el)
      io.observe(el)
    }
    for (const [id, el] of known) {
      if (!present.has(id)) {
        io.unobserve(el)
        known.delete(id)
        visibleRef.current.delete(id)
        const timer = settleTimers.current.get(id)
        if (timer) {
          clearTimeout(timer)
          settleTimers.current.delete(id)
        }
        if (settledRef.current.delete(id)) syncSettled()
        stopLatencyCycle(id)
      }
    }
  })

  // 稳定集变化 → perf watch 全量同步（主进程按 diff 增删监控，每台独立相位采样）。
  // 不可见仅停刷，已载数据保留不卸载
  useEffect(() => {
    window.aterm.perf.watch(perfEnabled ? settledIds : [])
  }, [settledIds, perfEnabled])
  useEffect(() => {
    return () => {
      window.aterm.perf.watch([])
      for (const timer of latencyTimers.current.values()) clearInterval(timer)
      latencyTimers.current.clear()
    }
  }, [])

  /* ---------------- 虚拟滚动：固定步进窗口 + 展开行实测高度 ---------------- */

  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)
  /** 展开行明细实测高度（含收起动画期间，RO 实时跟随） */
  const [expandedH, setExpandedH] = useState(0)
  const expandedRef = useRef<HTMLDivElement | null>(null)

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>): void => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => {
      const h = el.clientHeight
      if (h > 0) setViewportH(h)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 展开行高度跟随：open 与 closing 都测量（收起动画期间下方行平滑回落）
  const measureKey = expandedId ?? closingId
  useEffect(() => {
    if (!measureKey) {
      setExpandedH(0)
      return
    }
    const el = expandedRef.current
    if (!el) return
    const update = (): void => setExpandedH(el.offsetHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measureKey])

  const expandedIndex = expandedId ? connections.findIndex((c) => c.id === expandedId) : -1
  /** 行 i 的顶部偏移（展开行实测高度只影响其后各行） */
  const rowTop = (i: number): number =>
    i * ROW_STRIDE + (expandedIndex >= 0 && i > expandedIndex ? expandedH : 0)
  const totalH = connections.length * ROW_STRIDE + (expandedIndex >= 0 ? expandedH : 0)
  const windowStart = Math.max(0, Math.floor(scrollTop / ROW_STRIDE) - OVERSCAN)
  let windowEnd = windowStart
  while (windowEnd < connections.length && rowTop(windowEnd) < scrollTop + viewportH) windowEnd++
  const endExclusive = Math.min(connections.length, windowEnd + OVERSCAN)
  const visibleConnections = connections.slice(windowStart, endExclusive)
  const topSpacer = rowTop(windowStart)
  const bottomSpacer = Math.max(0, totalH - rowTop(endExclusive))

  const lastTableReveal = useRef<typeof reveal>(null)
  useEffect(() => {
    if (!reveal || lastTableReveal.current === reveal) return
    const index = connections.findIndex((c) => c.id === reveal.id)
    if (index < 0) return
    const raf = requestAnimationFrame(() => {
      const container = scrollRef.current
      if (!container) return
      lastTableReveal.current = reveal
      const top = index * ROW_STRIDE + (expandedIndex >= 0 && index > expandedIndex ? expandedH : 0)
      container.scrollTo({
        top: Math.max(0, top - (container.clientHeight - ROW_STRIDE) / 2),
        behavior: 'smooth'
      })
      setJumpHighlight({ ids: [reveal.id] })
      if (jumpTimer.current) clearTimeout(jumpTimer.current)
      jumpTimer.current = setTimeout(() => setJumpHighlight(null), 3000)
    })
    return () => cancelAnimationFrame(raf)
  }, [reveal, connections, expandedIndex, expandedH])

  /* ---------------- 列宽布局 ---------------- */

  // Reserve independent latency and performance columns before fitting host columns.
  const showPerfCol = perfEnabled && tableWidth >= 880
  const rawAvailable = Math.max(
    320,
    tableWidth - H_INSET * 2 - CHECKBOX_WIDTH - ACTION_WIDTH - (showPerfCol ? 290 : 90) - 4
  )
  const hostWidth = resolveHostWidth(preferred, rawAvailable, drag?.target)
  useEffect(() => {
    window.aterm.perf.setPaused(!active || !showPerfCol)
    return () => window.aterm.perf.setPaused(false)
  }, [active, showPerfCol])
  const beginColumnResize = (): void => {
    const session = { base: hostWidth, target: hostWidth }
    dragRef.current = session
    setDrag(session)
  }
  const previewColumnResize = (target: number): void => {
    if (!dragRef.current) return
    dragRef.current = { ...dragRef.current, target }
    setDrag(dragRef.current)
  }
  const commitColumnResize = (target: number): void => {
    const session = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!session) return
    const final = resolveHostWidth(session.base, rawAvailable, target)
    setPreferred(final)
    persistPreferred(final)
  }
  const resize = (): Omit<ColumnResizeSpec, 'onStart' | 'onPreview' | 'onCommit'> => ({
    label: t('conn.col.host'),
    width: hostWidth,
    min: HOST_MIN_WIDTH,
    max: rawAvailable - LIVE_WIDTH,
    active: !!drag
  })

  /* ---------------- 传给行的回调（引用稳定是 HostRow memo 命中的前提） ---------------- */

  const openEdit = useCallback((c: HostConnection) => onEdit(c), [onEdit])
  const openDelete = useCallback((c: HostConnection) => onDelete(c), [onDelete])
  const openNote = useCallback((c: HostConnection) => setNoteTarget(c), [])
  const handleToggleSelect = useCallback((id: string) => onToggleSelect(id), [onToggleSelect])
  const handleConnect = useCallback((c: HostConnection) => onConnect(c), [onConnect])
  const handleDuplicate = useCallback((c: HostConnection) => onDuplicate(c), [onDuplicate])
  const handleToast = useCallback((text: string) => onToast(text), [onToast])
  const handleLocate = useCallback((c: HostConnection) => onLocate(c), [onLocate])

  const visibleSelected = connections.filter((c) => selectedIds.has(c.id)).length
  const allSelected = connections.length > 0 && visibleSelected === connections.length
  const someSelected = visibleSelected > 0 && !allSelected

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col overflow-x-auto">
      <div className="flex h-8 min-w-[650px] shrink-0 items-center border-b border-line bg-surface px-4">
        <div style={{ width: CHECKBOX_WIDTH }} className="flex shrink-0 justify-center">
          <button
            type="button"
            aria-label={t(allSelected ? 'conn.deselectAll' : 'conn.selectAll')}
            onClick={() => onToggleSelectAll(!allSelected)}
          >
            <SelectCheckbox state={allSelected ? 'on' : someSelected ? 'some' : 'off'} />
          </button>
        </div>
        <div className="relative flex items-center" style={{ width: hostWidth }}>
          <SortHeaderCell
            title={t('conn.col.host')}
            active={sortColumn === 'name'}
            ascending={sortAscending}
            onClick={() => onToggleSort('name')}
            className="min-w-0 flex-1"
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton icon={ChevronDown} size={10} title={t('conn.live.sort')} />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {(['name', 'host', 'username'] as const).map((key) => (
                <DropdownMenuItem key={key} onClick={() => onToggleSort(key)}>
                  {t(`conn.col.${key}`)}
                  {sortColumn === key ? (sortAscending ? ' ↑' : ' ↓') : ''}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <ColumnResizeHandle
            {...resize()}
            onStart={beginColumnResize}
            onPreview={previewColumnResize}
            onCommit={commitColumnResize}
          />
        </div>
        <HeaderDivider />
        <div className="shrink-0 px-2.5 text-caption text-muted" style={{ width: LIVE_WIDTH }}>
          {t('conn.live.title')}
        </div>
        <HeaderDivider />
        <div
          className={cn(
            'flex min-w-[90px] items-center',
            showPerfCol ? 'w-[90px] shrink-0' : 'flex-1'
          )}
        >
          <SortHeaderCell
            title={t('conn.col.latency')}
            active={sortColumn === 'latency'}
            ascending={sortAscending}
            onClick={() => onToggleSort('latency')}
          />
          <IconButton
            icon={RotateCw}
            size={10}
            frame={18}
            title={t('common.refresh')}
            disabled={!connections.length}
            onClick={() => {
              refreshLatency(
                connections
                  .filter((c) => settledSet.has(c.id) && !c.jumpHostIds?.length)
                  .map((c) => ({ id: c.id, host: c.host, port: c.port }))
              )
            }}
          />
        </div>
        {showPerfCol && (
          <Fragment>
            <HeaderDivider />
            <div className="flex min-w-[200px] flex-1 items-center gap-2 px-2.5 text-caption text-muted">
              {t('conn.col.perf')}
              <IconButton
                icon={RotateCw}
                size={10}
                frame={18}
                title={t('common.refresh')}
                disabled={!connections.length}
                onClick={() => window.aterm.perf.refresh()}
              />
            </div>
          </Fragment>
        )}
        <HeaderDivider />
        <div className="shrink-0 pl-2.5 text-caption text-muted" style={{ width: ACTION_WIDTH }}>
          {t('conn.col.actions')}
        </div>
      </div>
      {connectionSessions.error && (
        <p role="status" className="px-4 py-1 text-caption text-danger">
          {t('conn.live.loadFailed')}
        </p>
      )}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 min-w-[650px] flex-1 overflow-y-auto"
      >
        {/* 虚拟滚动：上下 spacer 撑起总高，只渲染窗口内的行 */}
        <div style={{ height: topSpacer }} />
        {visibleConnections.map((c) => (
          <HostRow
            key={c.id}
            conn={c}
            items={sessionsByHost.get(c.id) ?? EMPTY_ITEMS}
            sessionsLoading={connectionSessions.loading}
            selected={selectedIds.has(c.id)}
            expanded={expandedId === c.id}
            closing={closingId === c.id}
            jumpFlash={!!jumpHighlight?.ids.includes(c.id)}
            hostWidth={hostWidth}
            showPerfCol={showPerfCol}
            onConnect={handleConnect}
            onEdit={openEdit}
            onDuplicate={handleDuplicate}
            onDelete={openDelete}
            onToggleSelect={handleToggleSelect}
            onToggleExpand={toggleExpanded}
            onNote={openNote}
            onToast={handleToast}
            onFlashJump={flashJumpHosts}
            onLocate={handleLocate}
            measureDetail={measureKey === c.id}
            detailRef={expandedRef}
          />
        ))}
        <div style={{ height: bottomSpacer }} />
      </div>
      {noteTarget && (
        <NoteEditorDialog
          hostId={noteTarget.id}
          hostName={noteTarget.name}
          hostAddress={
            noteTarget.port === 22 ? noteTarget.host : `${noteTarget.host}:${noteTarget.port}`
          }
          note={noteTarget.note}
          onDismiss={() => setNoteTarget(null)}
        />
      )}
    </div>
  )
}

/** 单行（含展开明细）：memo + 行内自订阅性能/延迟/链路 —— 单主机数据更新只重渲染该行 */
const HostRow = memo(function HostRow({
  conn,
  items,
  sessionsLoading,
  selected,
  expanded,
  closing,
  jumpFlash,
  hostWidth,
  showPerfCol,
  onConnect,
  onEdit,
  onDuplicate,
  onDelete,
  onToggleSelect,
  onToggleExpand,
  onNote,
  onToast,
  onFlashJump,
  onLocate,
  measureDetail,
  detailRef
}: {
  conn: HostConnection
  items: SshConnectionSession[]
  sessionsLoading: boolean
  selected: boolean
  expanded: boolean
  closing: boolean
  jumpFlash: boolean
  hostWidth: number
  showPerfCol: boolean
  onConnect: (c: HostConnection) => void
  onEdit: (c: HostConnection) => void
  onDuplicate: (c: HostConnection) => void
  onDelete: (c: HostConnection) => void
  onToggleSelect: (id: string) => void
  onToggleExpand: (id: string) => void
  onNote: (c: HostConnection) => void
  onToast: (text: string) => void
  onFlashJump: (ids: string[]) => void
  onLocate: (c: HostConnection) => void
  measureDetail: boolean
  detailRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const { t } = useTranslation()
  // 行级订阅：只认自己这份数据（对象/原始值粒度），他行更新不波及
  const sample = usePerfStore((s) => s.samples[conn.id])
  const cachedOsName = usePerfStore((s) => s.osNames[conn.id])
  const latency = useLatencyStore((s) => s.status[conn.id])
  const linkPhase = useLinksStore((s) => s.byHost[conn.id]?.phase)

  const phase = items.some((item) => item.phase === 'connected')
    ? 'connected'
    : (items.find((item) => item.phase === 'connecting' || item.phase === 'reconnecting')?.phase ??
      linkPhase)
  const userCount = items.filter(
    (item) => item.owner === 'user' && item.phase === 'connected'
  ).length
  const agentCount = items.filter(
    (item) => item.owner === 'agent' && item.phase === 'connected'
  ).length
  const connecting = items.filter(
    (item) => item.phase === 'connecting' || item.phase === 'reconnecting'
  ).length
  // 视觉上的"展开中"：含收起动画进行中的行（保持 ring/底色不突兀消失）
  const revealed = expanded || closing
  // 暂无任何 SSH 连接会话的主机不允许展开
  const expandable = items.length > 0
  // 连接计数（展开按钮与静态展示共用）
  const liveCounts = (
    <span className="flex min-w-0 flex-col gap-1 text-minor">
      <span
        className={cn(
          'flex items-center gap-2 tabular-nums',
          userCount ? 'text-info' : 'text-muted'
        )}
      >
        <UserRound size={14} className="shrink-0" />
        {t('session.connectionUser')} {sessionsLoading ? '…' : userCount}
      </span>
      <span
        className={cn(
          'flex items-center gap-2 tabular-nums',
          agentCount ? 'text-info' : 'text-muted'
        )}
      >
        <Bot size={14} className="shrink-0" />
        Agent {sessionsLoading ? '…' : agentCount}
        {connecting > 0 && (
          <span className="ml-2 text-warn" title={t('conn.live.connecting', { count: connecting })}>
            ◌ {connecting}
          </span>
        )}
      </span>
    </span>
  )
  return (
    <div
      className={cn(
        'relative',
        revealed && 'overflow-hidden rounded-lg bg-info/5 ring-1 ring-inset ring-info/30'
      )}
    >
      {/* 跳板链高亮：黄色动画虚线框（pulse-soft 呼吸闪烁） */}
      {jumpFlash && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 animate-[pulse-soft_0.65s_ease-in-out_infinite_alternate] rounded-lg border-2 border-dashed border-warn"
        />
      )}
      <div
        data-host-id={conn.id}
        className={cn(
          'group relative flex h-[72px] items-center border-b border-line px-4 transition-colors duration-150 hover:bg-hover/60',
          revealed && 'bg-info/10'
        )}
        onDoubleClick={(event) => {
          if (!(event.target as HTMLElement).closest('button,input')) onConnect(conn)
        }}
      >
        <span
          title={t(linkStateLabelKey(phase))}
          aria-label={t(linkStateLabelKey(phase))}
          className="host-status-light pointer-events-none absolute inset-y-0 left-0 w-[4px]"
          data-phase={phase ?? 'idle'}
          style={{
            backgroundColor: linkStateColor(phase),
            boxShadow: phase && phase !== 'idle' ? `0 0 8px ${linkStateColor(phase)}` : undefined,
            opacity: !phase || phase === 'idle' ? 0.3 : 1
          }}
        >
          <span className="absolute inset-0 bg-white/20" />
        </span>
        <div className="flex shrink-0 justify-center" style={{ width: CHECKBOX_WIDTH }}>
          <button
            type="button"
            aria-label={t('conn.live.selectHost', { name: conn.name })}
            onClick={() => onToggleSelect(conn.id)}
          >
            <SelectCheckbox state={selected ? 'on' : 'off'} />
          </button>
        </div>
        <CellBox style={{ width: hostWidth }} className="flex items-center gap-3">
          <OsIcon
            osName={
              isNetworkDevice(conn)
                ? ''
                : conn.deviceType
                  ? DEVICE_TYPES[conn.deviceType]
                  : sample?.osName || cachedOsName || ''
            }
            size={16}
            badge
          />
          <div className="min-w-0 flex-1">
            <div className="flex h-6 min-w-0 items-center gap-1.5">
              {/* 主机名可点：定位到左侧目录对应位置（按钮式 hover 反馈；负 margin 抵消内边距保持对齐） */}
              <button
                type="button"
                aria-label={t('conn.locateInGroups', { name: conn.name })}
                className="-mx-1 min-w-0 flex-1 rounded-md px-1 text-left transition-colors duration-100 hover:bg-hover"
                onClick={() => onLocate(conn)}
              >
                <ExpandableTextCell text={conn.name} weight="medium" className="text-body" />
              </button>
              {conn.deviceType && (
                <span
                  className="max-w-24 truncate text-caption text-muted"
                  title={DEVICE_TYPES[conn.deviceType]}
                >
                  {DEVICE_TYPES[conn.deviceType]}
                </span>
              )}
              {!!conn.jumpHostIds?.length && (
                <IconButton
                  icon={Link2}
                  size={12}
                  title={t('conn.viaJumpHint')}
                  onClick={() => onFlashJump(conn.jumpHostIds ?? [])}
                />
              )}
              <NoteIconButton hasContent={noteHasContent(conn.note)} onClick={() => onNote(conn)} />
            </div>
            <HostAddressCell
              text={`${conn.username}@${conn.host.includes(':') ? '[' + conn.host + ']' : conn.host}:${conn.port}`}
              onCopy={() => onToast(t('common.copied'))}
            />
          </div>
        </CellBox>
        <CellBox style={{ width: LIVE_WIDTH }}>
          {expandable ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={t('conn.live.details', { name: conn.name })}
              className="flex w-full items-center justify-between gap-1 rounded-md px-2 py-1 text-left hover:bg-hover/60"
              onClick={() => onToggleExpand(conn.id)}
            >
              {liveCounts}
              <ChevronDown
                size={12}
                className={cn('shrink-0 text-muted transition-transform', expanded && 'rotate-180')}
              />
            </button>
          ) : (
            // 暂无连接：只读展示计数，无展开入口
            <div className="flex w-full items-center px-2 py-1">{liveCounts}</div>
          )}
        </CellBox>
        <CellBox className={cn('min-w-[90px] pr-0', showPerfCol ? 'w-[90px]' : 'flex-1')}>
          <LatencyCell
            status={(latency ?? 'idle') as LatencyStatus}
            off={!!conn.jumpHostIds?.length}
          />
        </CellBox>
        {showPerfCol && (
          <div data-column="performance" className="min-w-[200px] flex-1 overflow-hidden px-2.5">
            <PerfCell
              sample={
                isNetworkDevice(conn) || conn.perfDisabled || conn.jumpHostIds?.length
                  ? null
                  : (sample ?? null)
              }
            />
          </div>
        )}
        <div
          data-column="actions"
          className="flex shrink-0 items-center justify-end gap-1.5 pr-2.5"
          style={{ width: ACTION_WIDTH }}
        >
          <Button
            size="sm"
            title={t('common.connect')}
            className="shrink-0"
            onClick={() => onConnect(conn)}
          />
          <IconButton
            icon={Pencil}
            size={11.5}
            aria-label={t('common.edit')}
            onClick={() => onEdit(conn)}
          />
          <RowMenu onDuplicate={() => onDuplicate(conn)} onDelete={() => onDelete(conn)} />
        </div>
      </div>
      <RevealRow open={expanded}>
        <div ref={measureDetail ? detailRef : undefined}>
          {(expanded || closing) && (
            <ConnectionSessionsDetail
              hostId={conn.id}
              name={conn.name}
              items={items}
              onToast={onToast}
            />
          )}
        </div>
      </RevealRow>
    </div>
  )
})

function CellBox({
  children,
  className,
  style
}: {
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element {
  return (
    <div className={cn('min-w-0 shrink-0 px-2.5', className)} style={style}>
      {children}
    </div>
  )
}

function HeaderDivider(): React.JSX.Element {
  return <div className="h-4 w-px shrink-0 bg-line/90" />
}

/** 对照 SortHeaderCell：11px 标题（激活 bold）+ 方向箭头；hover/激活底色 + 右缘拖宽手柄 */
function SortHeaderCell({
  title,
  active,
  ascending,
  onClick,
  className,
  style,
  resize
}: {
  title: string
  active: boolean
  ascending: boolean
  onClick: () => void
  className?: string
  style?: React.CSSProperties
  /** 传入即在右缘渲染拖宽手柄（absorber 态不传 = 无手柄） */
  resize?: ColumnResizeSpec
}): React.JSX.Element {
  const [hovering, setHovering] = useState(false)
  return (
    <div className={cn('relative flex h-8 shrink-0 items-center', className)} style={style}>
      <button
        type="button"
        className={cn(
          'flex h-8 w-full items-center gap-1 px-2.5 text-left outline-none transition-colors duration-100',
          hovering ? 'bg-hover/55' : active ? 'bg-hover/25' : 'bg-transparent'
        )}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onClick={onClick}
      >
        <span
          className={cn(
            'truncate text-caption',
            active ? 'font-semibold text-fg' : 'font-medium text-muted'
          )}
        >
          {title}
        </span>
        {active ? (
          ascending ? (
            <ChevronUp size={8} strokeWidth={3} className="shrink-0 text-fg" />
          ) : (
            <ChevronDown size={8} strokeWidth={3} className="shrink-0 text-fg" />
          )
        ) : (
          <ArrowUpDown size={8} strokeWidth={3} className="shrink-0 text-muted" />
        )}
      </button>
      {resize && <ColumnResizeHandle {...resize} />}
    </div>
  )
}

interface ColumnResizeSpec {
  /** 无障碍标签（列名） */
  label: string
  /** 当前列渲染宽（拖拽起始基准） */
  width: number
  min: number
  max: number
  active: boolean
  onStart: () => void
  onPreview: (target: number) => void
  onCommit: (target: number) => void
}

/** 对照 ColumnResizeHandle：8px 热区跨列分隔符居中 / 3px accent 视觉条。
 *  指针捕获/键盘微调/钳制由 useResizePreview 提供；预览即实时生效（表格重排廉价，无需预览线） */
function ColumnResizeHandle({
  label,
  width,
  min,
  max,
  active,
  onStart,
  onPreview,
  onCommit
}: ColumnResizeSpec): React.JSX.Element {
  const { handleProps } = useResizePreview({ value: width, min, max, onPreview, onCommit })
  const { onPointerDown, onKeyDown, ...separatorProps } = handleProps
  const [hovering, setHovering] = useState(false)
  return (
    <div
      {...separatorProps}
      aria-label={label}
      className="absolute inset-y-0 right-[-3.5px] z-10 flex w-2 cursor-col-resize touch-none items-center justify-center outline-none"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onPointerDown={(e) => {
        // 右键不开启拖拽会话；键盘路径同样先建会话再提交（每次按键独立成段）
        if (e.button === 0) onStart()
        onPointerDown(e)
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') onStart()
        onKeyDown(e)
      }}
    >
      <div
        className={cn(
          'h-6 w-[3px] rounded-full',
          active || hovering ? 'bg-at-accent/55' : 'bg-transparent'
        )}
      />
    </div>
  )
}

/** 三态复选框（共享 CheckBox 组件） */
function SelectCheckbox({ state }: { state: 'off' | 'on' | 'some' }): React.JSX.Element {
  return <CheckBox state={state} />
}

/** 行尾"更多"菜单：复制连接 / 删除（编辑按钮在外侧直出） */
function RowMenu({
  onDuplicate,
  onDelete
}: {
  onDuplicate: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton icon={Ellipsis} size={12} title={t('common.moreActions')} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuItem onClick={onDuplicate}>{t('conn.duplicate')}</DropdownMenuItem>
        <DropdownMenuSeparator className="bg-line" />
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          {t('common.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
