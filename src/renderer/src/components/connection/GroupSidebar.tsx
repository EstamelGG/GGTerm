import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ChevronsDownUp, Copy, Crosshair, FolderPlus, Pencil, Plug, Plus, RotateCw, Server, ServerPlus, Trash2 } from 'lucide-react'
import type { HostConnection, HostGroup } from '@shared/types'
import { cn } from '@/lib/utils'
import { hexToCss } from '@/lib/theme'
import { childrenOf, descendantsOf, groupChain } from '@shared/groupTree'
import { ChromeSeparator } from '@/components/chrome/ChromeSeparator'
import { IconButton } from '@/components/ui/IconButton'
import { useConnectionsStore } from '@/stores/connections'
import { useLinksStore } from '@/stores/links'
import { TOOLBAR_V } from '@/components/chrome/layout'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'

export type SidebarPick = { kind: 'all' } | { kind: 'ungrouped' } | { kind: 'group'; id: string }

/** 未分组行的折叠键（真实分组用 group.id） */
const UNGROUPED_KEY = '__ungrouped__'

/** 定位滚动时焦点行上下各留的呼吸空间（约两行高）；首行/末行由 clamp 自然收敛不硬留 */
const REVEAL_PAD = 48

/** 连接行拖拽调组的自定义 MIME（区别于 SFTP 树的 application/x-aterm-sftp，防终端误收） */
export const CONN_DRAG_MIME = 'application/x-aterm-conn'

/** 层级缩进步长与参考线锚点（Guides / SideRow / ConnRow 共用，改一处即全局生效） */
export const INDENT_STEP = 14
const GUIDE_BASE = 16
const ROW_BASE = 8

/** 层级参考线：每个祖先层级一条竖线，x 对齐该层箭头/图标槽中心列 */
function Guides({ depth }: { depth: number }): ReactNode {
  if (depth <= 0) return null
  return Array.from({ length: depth }, (_, i) => (
    <span
      key={i}
      className="pointer-events-none absolute inset-y-0 w-px bg-muted/25"
      style={{ left: i * INDENT_STEP + GUIDE_BASE }}
    />
  ))
}

/** 对照 ConnectionPage.swift sidebar：228pt 分组侧栏（分组树 + 组内连接行，可折叠） */
export function GroupSidebar({
  pick,
  onPick,
  connections,
  groups,
  reveal,
  onNewConnection,
  onNewGroup,
  onRenameGroup,
  onDeleteGroup,
  onMoveConnection,
  onConnect,
  onEdit,
  onCopyAddress,
  onLocate,
  onDelete
}: {
  pick: SidebarPick
  onPick: (pick: SidebarPick) => void
  connections: HostConnection[]
  groups: HostGroup[]
  /** 外部定位请求（表格主机名点击 → { id, n }，n 递增保证重复点击同一主机也重新滚动） */
  reveal: { id: string; n: number } | null
  onNewConnection: (groupId: string | null) => void
  onNewGroup: (parentId: string | null) => void
  onRenameGroup: (group: HostGroup) => void
  onDeleteGroup: (group: HostGroup) => void
  /** 拖拽调组：连接行拖到分组行/未分组行（groupId=null 移出分组） */
  onMoveConnection: (connId: string, groupId: string | null) => void
  onConnect: (c: HostConnection) => void
  onEdit: (c: HostConnection) => void
  onCopyAddress: (c: HostConnection) => void
  onLocate: (c: HostConnection) => void
  onDelete: (c: HostConnection) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  /** 侧栏单一焦点：分组行与连接行共用一个高亮（连接选中时分组行不高亮，表格筛选不变） */
  const [focus, setFocus] = useState<{ kind: 'pick' } | { kind: 'conn'; id: string }>({
    kind: 'pick'
  })
  const pickActive = focus.kind === 'pick'

  const toggle = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** 折叠全部：全部分组（含未分组行）一次性收起；已全折叠则恢复展开 */
  const collapseAll = (): void => {
    const all = new Set<string>([UNGROUPED_KEY, ...groups.map((g) => g.id)])
    setCollapsed((prev) => ([...all].every((key) => prev.has(key)) ? new Set() : all))
  }

  /** 点击分组/筛选行：切换筛选并把焦点收回分组行 */
  const pickAndClear = (p: SidebarPick): void => {
    setFocus({ kind: 'pick' })
    onPick(p)
  }

  /** 滚动容器：定位时在容器内查询目标行（ConnRow 带 data-host-id），避免误匹配表格行 */
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 已处理的 reveal：connections/groups 变化重跑 effect 时不重复滚动 */
  const lastReveal = useRef<{ id: string; n: number } | null>(null)

  /** 外部定位：展开祖先分组链 → focus 选中 → 平滑滚动到该行 */
  useEffect(() => {
    if (!reveal) return
    if (lastReveal.current?.id === reveal.id && lastReveal.current?.n === reveal.n) return
    lastReveal.current = reveal
    const conn = connections.find((c) => c.id === reveal.id)
    if (!conn) return
    const chain = conn.groupId ? groupChain(conn.groupId, groups).map((g) => g.id) : [UNGROUPED_KEY]
    let inner = 0
    // setState 放入 rAF 回调（异步），避免 effect 体内同步 setState；嵌套 rAF 等展开后的新提交渲染出行节点再滚动
    const raf = requestAnimationFrame(() => {
      setCollapsed((prev) => {
        if (!chain.some((k) => prev.has(k))) return prev
        const next = new Set(prev)
        for (const k of chain) next.delete(k)
        return next
      })
      setFocus({ kind: 'conn', id: reveal.id })
      inner = requestAnimationFrame(() => {
        const container = scrollRef.current
        const row = container?.querySelector(`[data-host-id="${CSS.escape(reveal.id)}"]`)
        if (!container || !row) return
        // 手动计算目标滚动位：焦点行上下各留 REVEAL_PAD 呼吸空间；
        // clamp 到 [0, 可滚动上限]，首行/末行自然贴边不硬留
        const box = container.getBoundingClientRect()
        const rect = row.getBoundingClientRect()
        const target = rect.top - box.top + container.scrollTop - REVEAL_PAD
        const next = Math.max(0, Math.min(target, container.scrollHeight - container.clientHeight))
        if (Math.abs(next - container.scrollTop) < 1) return
        container.scrollTo({ top: next, behavior: 'smooth' })
      })
    })
    return () => {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(inner)
    }
    // 仅由 reveal 驱动；connections/groups 读快照即可，避免数据变化时重复滚动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal])

  const ungrouped = connections
    .filter((c) => c.groupId === null)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans'))
  const ungroupedOpen = !collapsed.has(UNGROUPED_KEY)

  /** 分组树：组行 → 组内连接行 → 子分组（DFS，折叠即整枝隐藏） */
  const renderGroups = (parentId: string | null, depth: number): ReactNode =>
    childrenOf(parentId, groups).map((g) => {
      const kids = connections
        .filter((c) => c.groupId === g.id)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans'))
      const hasSub = groups.some((x) => x.parentId === g.id)
      /** 计数递归：自身 + 全部后代分组内的连接都算进来 */
      const subtreeIds = descendantsOf(g.id, groups)
      subtreeIds.add(g.id)
      const count = connections.filter((c) => c.groupId && subtreeIds.has(c.groupId)).length
      const open = !collapsed.has(g.id)
      return (
        <Fragment key={g.id}>
          <SideRow
            on={pickActive && pick.kind === 'group' && pick.id === g.id}
            onClick={() => pickAndClear({ kind: 'group', id: g.id })}
            dotColor={hexToCss(g.colorHex)}
            title={g.name}
            count={count}
            depth={depth}
            expandable={kids.length > 0 || hasSub}
            expanded={open}
            onToggle={() => toggle(g.id)}
            onDropConnection={(connId) => onMoveConnection(connId, g.id)}
            contextMenu={
              <GroupRowMenu
                onNewConnection={() => onNewConnection(g.id)}
                onNewSubgroup={() => onNewGroup(g.id)}
                onRename={() => onRenameGroup(g)}
                onDelete={() => onDeleteGroup(g)}
              />
            }
          />
          {open && (
            <>
              {kids.map((c) => (
                <ConnRow
                  key={c.id}
                  conn={c}
                  depth={depth + 1}
                  selected={focus.kind === 'conn' && focus.id === c.id}
                  onSelect={() => setFocus({ kind: 'conn', id: c.id })}
                  onConnect={onConnect}
                  onEdit={onEdit}
                  onCopyAddress={onCopyAddress}
                  onLocate={onLocate}
                  onDelete={onDelete}
                />
              ))}
              {renderGroups(g.id, depth + 1)}
            </>
          )}
        </Fragment>
      )
    })

  return (
    <aside className="flex h-full w-full flex-col bg-sidebar">
      <div className={cn('flex items-center px-3.5', TOOLBAR_V)}>
        <span className="flex-1 text-caption font-semibold text-muted">{t('conn.groups')}</span>
        <span className="flex items-center gap-1">
          <IconButton
            variant="toolbar"
            icon={RotateCw}
            frame={24}
            aria-label={t('common.refresh')}
            title={t('common.refresh')}
            onClick={() => void useConnectionsStore.getState().load()}
          />
          <IconButton
            variant="toolbar"
            icon={ChevronsDownUp}
            frame={24}
            aria-label={t('conn.collapseAll')}
            onClick={collapseAll}
          />
          <IconButton
            variant="toolbar"
            icon={Plus}
            frame={24}
            aria-label={t('conn.newGroup')}
            onClick={() => onNewGroup(null)}
          />
        </span>
      </div>
      <ChromeSeparator />
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3 pt-2"
      >
        <SideRow
          on={pickActive && pick.kind === 'all'}
          onClick={() => pickAndClear({ kind: 'all' })}
          dotColor="var(--at-info)"
          title={t('conn.all')}
          count={connections.length}
        />
        <SideRow
          on={pickActive && pick.kind === 'ungrouped'}
          onClick={() => pickAndClear({ kind: 'ungrouped' })}
          dotColor="var(--at-muted)"
          title={t('conn.ungrouped')}
          count={ungrouped.length}
          expandable={ungrouped.length > 0}
          expanded={ungroupedOpen}
          onToggle={() => toggle(UNGROUPED_KEY)}
          onDropConnection={(connId) => onMoveConnection(connId, null)}
        />
        {ungroupedOpen &&
          ungrouped.map((c) => (
            <ConnRow
              key={c.id}
              conn={c}
              depth={1}
              selected={focus.kind === 'conn' && focus.id === c.id}
              onSelect={() => setFocus({ kind: 'conn', id: c.id })}
              onConnect={onConnect}
              onEdit={onEdit}
              onCopyAddress={onCopyAddress}
              onLocate={onLocate}
              onDelete={onDelete}
            />
          ))}
        {renderGroups(null, 0)}
      </div>
    </aside>
  )
}

function GroupRowMenu({
  onNewConnection,
  onNewSubgroup,
  onRename,
  onDelete
}: {
  onNewConnection: () => void
  onNewSubgroup: () => void
  onRename: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ContextMenuContent className="w-44 border-line">
      <ContextMenuItem onClick={onNewConnection}>
        <ServerPlus />
        {t('conn.newConnection')}
      </ContextMenuItem>
      <ContextMenuItem onClick={onNewSubgroup}>
        <FolderPlus />
        {t('conn.newSubgroup')}
      </ContextMenuItem>
      <ContextMenuSeparator className="bg-line" />
      <ContextMenuItem onClick={onRename}>
        <Pencil />
        {t('common.rename')}
      </ContextMenuItem>
      <ContextMenuSeparator className="bg-line" />
      <ContextMenuItem variant="destructive" onClick={onDelete}>
        <Trash2 />
        {t('common.delete')}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

function ConnRowMenu({
  onConnect,
  onEdit,
  onCopyAddress,
  onDelete
}: {
  onConnect: () => void
  onEdit: () => void
  onCopyAddress: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ContextMenuContent className="w-44 border-line">
      <ContextMenuItem onClick={onConnect}>
        <Plug />
        {t('common.connect')}
      </ContextMenuItem>
      <ContextMenuItem onClick={onEdit}>
        <Pencil />
        {t('common.edit')}
      </ContextMenuItem>
      <ContextMenuSeparator className="bg-line" />
      <ContextMenuItem onClick={onCopyAddress}>
        <Copy />
        {t('conn.copyAddress')}
      </ContextMenuItem>
      <ContextMenuSeparator className="bg-line" />
      <ContextMenuItem variant="destructive" onClick={onDelete}>
        <Trash2 />
        {t('common.delete')}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/** 对照 sideRow + SftpNode：选中 bg-hover、hover bg-hover/70、r7；行首 16px 箭头槽（可折叠）。
 *  onDropConnection 存在 = 接受连接行拖入（dragover 高亮 + drop 回调） */
function SideRow({
  on,
  onClick,
  dotColor,
  title,
  count,
  depth = 0,
  expandable = false,
  expanded = false,
  onToggle,
  onDropConnection,
  contextMenu
}: {
  on: boolean
  onClick: () => void
  dotColor: string
  title: string
  count: number
  depth?: number
  expandable?: boolean
  expanded?: boolean
  onToggle?: () => void
  onDropConnection?: (connId: string) => void
  contextMenu?: ReactNode
}): React.JSX.Element {
  const [hovering, setHovering] = useState(false)
  const [dropHover, setDropHover] = useState(false)
  // 右键菜单打开期间保持行高亮（radix modal 会锁 body pointer-events 触发 mouseleave）
  const [menuOpen, setMenuOpen] = useState(false)
  const row = (
    <button
      type="button"
      className={cn(
        'relative flex w-full shrink-0 items-center gap-2 rounded-lg py-1.5 pr-2 text-left transition-colors duration-100',
        dropHover
          ? 'bg-at-accent/15 ring-[1.5px] ring-at-accent/70'
          : on || menuOpen
            ? 'bg-hover'
            : hovering
              ? 'bg-hover/70'
              : 'bg-transparent'
      )}
      style={{ paddingLeft: depth * INDENT_STEP + ROW_BASE }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onClick={onClick}
      onDragOver={(e) => {
        if (!onDropConnection || !e.dataTransfer.types.includes(CONN_DRAG_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropHover(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        setDropHover(false)
      }}
      onDrop={(e) => {
        if (!onDropConnection) return
        e.preventDefault()
        setDropHover(false)
        const connId = e.dataTransfer.getData(CONN_DRAG_MIME)
        if (connId) onDropConnection(connId)
      }}
    >
      <Guides depth={depth} />
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {expandable && onToggle ? (
          <span
            role="button"
            tabIndex={-1}
            className="flex h-4 w-4 items-center justify-center rounded-sm text-muted hover:text-fg"
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
          >
            <ChevronRight
              size={10}
              strokeWidth={2.4}
              className={cn('transition-transform duration-100', expanded && 'rotate-90')}
            />
          </span>
        ) : null}
      </span>
      <span
        className="h-[7px] w-[7px] shrink-0 rounded-full"
        style={{ backgroundColor: dotColor }}
      />
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span
          className={cn(
            'min-w-0 truncate text-minor',
            on ? 'font-semibold text-fg' : 'text-muted'
          )}
        >
          {title}
        </span>
        <span className="shrink-0 text-caption font-medium tabular-nums text-muted">{count}</span>
      </span>
    </button>
  )
  if (!contextMenu) return row
  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      {contextMenu}
    </ContextMenu>
  )
}

/** 分组下的连接行：draggable 拖入分组调组；单击选中、双击连接（与主表格一致）；右键复用表格操作 */
function ConnRow({
  conn,
  depth,
  selected,
  onSelect,
  onConnect,
  onEdit,
  onCopyAddress,
  onLocate,
  onDelete
}: {
  conn: HostConnection
  depth: number
  selected: boolean
  onSelect: () => void
  onConnect: (c: HostConnection) => void
  onEdit: (c: HostConnection) => void
  onCopyAddress: (c: HostConnection) => void
  onLocate: (c: HostConnection) => void
  onDelete: (c: HostConnection) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [hovering, setHovering] = useState(false)
  // 与主机行首指示灯同源的链路状态：已连接 → 图标绿色缓慢呼吸
  const phase = useLinksStore((s) => s.byHost[conn.id]?.phase)
  // 右键菜单打开期间保持行高亮（radix modal 会锁 body pointer-events 触发 mouseleave）
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          title={conn.name}
          data-host-id={conn.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(CONN_DRAG_MIME, conn.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          className={cn(
            'relative flex w-full shrink-0 items-center gap-2 rounded-lg py-1 pr-2 text-left transition-colors duration-100',
            menuOpen || selected ? 'bg-hover' : hovering ? 'bg-hover/70' : 'bg-transparent'
          )}
          style={{ paddingLeft: depth * INDENT_STEP + ROW_BASE }}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
          onClick={onSelect}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onSelect()
            }
          }}
          onDoubleClick={() => onConnect(conn)}
        >
          <Guides depth={depth} />
          <span className="flex h-4 w-4 shrink-0 items-center justify-center" />
          <Server
            size={12}
            strokeWidth={2}
            // 选中态只靠行底色高亮，图标不再叠加主题色（已连接=绿色呼吸）
            className={cn('shrink-0', phase === 'connected' ? 'conn-server-connected' : 'text-muted')}
          />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-minor',
              selected ? 'font-medium text-fg' : 'text-muted'
            )}
          >
            {conn.name}
          </span>
          <IconButton
            icon={Crosshair}
            frame={18}
            title={t('conn.locateInList', { name: conn.name })}
            className={cn(!hovering && !selected && 'invisible')}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onSelect()
              onLocate(conn)
            }}
          />
        </div>
      </ContextMenuTrigger>
      <ConnRowMenu
        onConnect={() => onConnect(conn)}
        onEdit={() => onEdit(conn)}
        onCopyAddress={() => onCopyAddress(conn)}
        onDelete={() => onDelete(conn)}
      />
    </ContextMenu>
  )
}
