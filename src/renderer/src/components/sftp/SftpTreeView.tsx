import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Tree,
  type NodeApi,
  type NodeRendererProps,
  type RowRendererProps,
  type TreeApi
} from 'react-arborist'
import {
  Bot,
  ChevronRight,
  ClipboardCopy,
  Copy,
  Download,
  FilePlus,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Info,
  KeyRound,
  Link2,
  Loader2,
  Pencil,
  SquarePen,
  SquareTerminal,
  Trash2,
  Upload
} from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { fileVisual } from './fileVisual'
import type { SftpEntry } from '@shared/types'
import { canMove, parentPath } from '@shared/sftpPath'
import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { listedEntries, useSftpStore, type SftpPaneState } from '@/stores/sftp'

/**
 * 目录树：react-arborist（虚拟化，只渲染可视行）。
 * - store（children/expanded 缓存 + load/reveal）仍是唯一数据源，树受控对齐
 * - 单击仅选中（⌘/⇧ 多选）；双击展开目录/打开文件；箭头单击可展开
 * - 树内拖拽=移入目标文件夹（canMove 防护、同目录 no-op）；外部文件拖入上传
 * - 空目录占位行（虚线框）；加载时箭头位换转圈，文件夹图标不受影响
 */

export interface SftpTreeActions {
  onSendToAi: (entry: SftpEntry) => void
  onOpenFile: (entry: SftpEntry) => void
  onInfo: (entry: SftpEntry) => void
  onRename: (entry: SftpEntry) => void
  onMoveTo: (entry: SftpEntry) => void
  onChmod: (entry: SftpEntry) => void
  onNewFile: (dir: string) => void
  onMkdir: (dir: string) => void
  onDownload: (entry: SftpEntry) => void
  onDelete: (entries: SftpEntry[]) => void
  onOpenTerminal: (dir: string) => void
  onUploadFiles: (dir: string) => void
  onUploadFolders: (dir: string) => void
  onCopyName: (entry: SftpEntry) => void
  onCopyPath: (entry: SftpEntry) => void
  onMove: (entry: SftpEntry, destDir: string) => void
  onUploadPaths: (localPaths: string[], destDir: string) => void
}

function entryByPath(pane: SftpPaneState, path: string): SftpEntry | null {
  return (pane.children[parentPath(path)] ?? []).find((e) => e.path === path) ?? null
}

const EMPTY_SUFFIX = '/__empty__'
const ERROR_SUFFIX = '/__error__'

interface TreeDatum {
  id: string
  entry?: SftpEntry
  placeholder?: boolean
  /** 列目录失败占位行（权限不足等）：红色虚线目录图标 + 错误文本 */
  errorMsg?: string
  children?: TreeDatum[]
}

/** pane.children 缓存 → arborist 树数据（目录一律给 children；空目录/列目录失败给占位节点） */
function buildDirData(pane: SftpPaneState, dir: string): TreeDatum[] {
  if (pane.errors[dir] !== undefined)
    return [{ id: `${dir}${ERROR_SUFFIX}`, errorMsg: pane.errors[dir] }]
  const loaded = pane.children[dir] !== undefined
  if (!loaded) return []
  const entries = listedEntries(pane, dir)
  if (entries.length === 0) return [{ id: `${dir}${EMPTY_SUFFIX}`, placeholder: true }]
  return entries.map((e) => {
    const d: TreeDatum = { id: e.path, entry: e }
    if (e.isDir) d.children = buildDirData(pane, e.path)
    return d
  })
}

/** 内部拖拽自定义 MIME（原生 HTML5 DnD 自建拖拽层）；终端拖放插入路径也按此识别 */
export const INTERNAL_MIME = 'application/x-aterm-sftp'

/** 行渲染器/节点渲染器共享上下文（arborist 的 renderRow 不透传自定义 props） */
const TreeContext = createContext<{
  hostId: string
  actions: SftpTreeActions
  /** 内外部拖拽共用的落点目录高亮（目录整块子树） */
  overDir: string | null
  onRowDragStart: (e: React.DragEvent, node: NodeApi<TreeDatum>) => void
  onRowDragOver: (e: React.DragEvent, node: NodeApi<TreeDatum>) => void
  onRowDrop: (e: React.DragEvent, node: NodeApi<TreeDatum>) => void
  onRowDragEnd: () => void
}>({
  hostId: '',
  actions: null as unknown as SftpTreeActions,
  overDir: null,
  onRowDragStart: () => {},
  onRowDragOver: () => {},
  onRowDrop: () => {},
  onRowDragEnd: () => {}
})

/** 不渲染插入光标：SFTP 按名称排序，无自定义位置，拖放只表达"移入目标目录" */
function NullCursor(): null {
  return null
}

export function SftpTreeView({
  hostId,
  pane,
  selected,
  onSelectedChange,
  actions
}: {
  hostId: string
  pane: SftpPaneState
  selected: string[]
  onSelectedChange: (paths: string[]) => void
  actions: SftpTreeActions
}): React.JSX.Element {
  const { t } = useTranslation()
  const treeRef = useRef<TreeApi<TreeDatum>>(undefined)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  /** —— 自建拖拽层（原生 HTML5 DnD）：整行命中，内部/外部高亮共用 overDir，不依赖库内部时序 —— */
  const dragPathsRef = useRef<string[] | null>(null)
  const [overDir, setOverDir] = useState<string | null>(null)

  /** 落点目录：目录行=自身，文件行=所在目录，空目录占位行=其父目录 */
  const resolveDropDir = useCallback(
    (node: NodeApi<TreeDatum>): string => {
      const entry = node.data.entry
      if (entry) return entry.isDir ? entry.path : parentPath(entry.path)
      return node.parent?.id ?? pane.root
    },
    [pane.root]
  )

  /** 合法移动：全部拖拽项 canMove 且目标 ≠ 来源目录 */
  const validMove = useCallback(
    (paths: string[], destDir: string): boolean => {
      const entries = paths
        .map((p) => entryByPath(pane, p))
        .filter((x): x is SftpEntry => x !== null)
      return (
        entries.length > 0 &&
        entries.every((en) => canMove(en, destDir) && parentPath(en.path) !== destDir)
      )
    },
    [pane]
  )

  const clearDrag = useCallback((): void => {
    dragPathsRef.current = null
    setOverDir(null)
  }, [])

  /** spring-loading：悬停闭合目录 1s 自动展开（内部拖拽=合法落点才计；外部文件拖入=任意目录） */
  const springRef = useRef<{ dir: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const clearSpring = useCallback((): void => {
    if (springRef.current) {
      clearTimeout(springRef.current.timer)
      springRef.current = null
    }
  }, [])
  useEffect(() => clearSpring, [clearSpring])
  const springDir = useCallback(
    (dir: string | null): void => {
      if (dir !== null && springRef.current?.dir === dir) return // 计时继续
      clearSpring()
      if (dir === null) return
      const entry = entryByPath(pane, dir)
      if (!entry?.isDir || pane.expanded.includes(dir)) return
      springRef.current = {
        dir,
        timer: setTimeout(() => {
          springRef.current = null
          treeRef.current?.open(dir) // 命令式展开 → onToggle → store.toggle 懒加载
        }, 1000)
      }
    },
    [clearSpring, pane]
  )

  const onRowDragStart = useCallback(
    (e: React.DragEvent, node: NodeApi<TreeDatum>) => {
      const entry = node.data.entry
      if (!entry) {
        e.preventDefault()
        return
      }
      // 拖选中行 = 带走整个选区；拖未选中行 = 单项（并选中它）
      const paths = node.isSelected && selected.length > 1 ? selected : [entry.path]
      dragPathsRef.current = paths
      e.dataTransfer.setData(INTERNAL_MIME, JSON.stringify({ paths }))
      // copyMove：树内移动用 'move'，拖到终端插入路径用 'copy'——两端都合法，否则 drop 事件被浏览器拒绝
      e.dataTransfer.effectAllowed = 'copyMove'
      if (!node.isSelected) node.select()
      // 关键：阻断冒泡到 window——react-dnd(HTML5Backend) 会对"非其管理"的原生拖拽
      // 调 preventDefault() 掐死会话（无 dragover/dragend），见 HTML5BackendImpl.handleTopDragStart
      e.stopPropagation()
    },
    [selected]
  )

  const onRowDragOver = useCallback(
    (e: React.DragEvent, node: NodeApi<TreeDatum>) => {
      const paths = dragPathsRef.current
      if (!paths) return // 非内部移动（外部文件拖入等）交给容器层
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      // 关键：阻断冒泡到 window——react-dnd 对外来拖拽会覆写 dropEffect='none'，
      // 导致释放被当作取消（有 dragend 无 drop），见 HTML5BackendImpl.handleTopDragOver
      e.stopPropagation()
      const destDir = resolveDropDir(node)
      const ok = validMove(paths, destDir)
      setOverDir(ok ? destDir : null)
      springDir(ok ? destDir : null)
    },
    [resolveDropDir, validMove, springDir]
  )

  const onRowDrop = useCallback(
    (e: React.DragEvent, node: NodeApi<TreeDatum>) => {
      const paths = dragPathsRef.current
      if (!paths) return
      e.preventDefault()
      e.stopPropagation()
      const destDir = resolveDropDir(node)
      clearDrag()
      clearSpring()
      if (!validMove(paths, destDir)) return
      // 多项拖拽暂走首项（与历史行为一致，批量确认流后续可扩展）
      const first = paths.map((p) => entryByPath(pane, p)).find((x): x is SftpEntry => x !== null)
      if (first) actions.onMove(first, destDir)
    },
    [pane, actions, resolveDropDir, validMove, clearDrag, clearSpring]
  )

  const onRowDragEnd = useCallback((): void => {
    clearDrag()
    clearSpring()
  }, [clearDrag, clearSpring])

  useEffect(() => {
    const clear = (): void => {
      clearDrag()
      clearSpring()
    }
    document.addEventListener('dragend', clear)
    document.addEventListener('drop', clear)
    return () => {
      document.removeEventListener('dragend', clear)
      document.removeEventListener('drop', clear)
    }
  }, [clearDrag, clearSpring])

  // 外部文件拖入：整树遮罩 + 目标目录行级高亮（与内部拖拽共用 overDir）
  const [dropArmed, setDropArmed] = useState(false)

  const ctxValue = useMemo(
    () => ({ hostId, actions, overDir, onRowDragStart, onRowDragOver, onRowDrop, onRowDragEnd }),
    [hostId, actions, overDir, onRowDragStart, onRowDragOver, onRowDrop, onRowDragEnd]
  )

  /** 自愈：空白树检测计数（连续重挂载上限，健康后清零） */
  const [treeNonce, setTreeNonce] = useState(0)
  const healAttempts = useRef(0)

  // 虚拟化需要像素高度：测量容器
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 数据依赖 children/showHidden/focusedPath/errors（列目录失败只 patch errors，必须触发重算才能出现红色占位行）
  const data = useMemo(
    () => buildDirData(pane, pane.root),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pane.children, pane.showHidden, pane.focusedPath, pane.root, pane.errors]
  )

  /** 自愈 1：根目录缓存丢失（children[root] 缺失）→ 空闲时自动重载根目录 */
  const rootMissing = pane.status === 'connected' && pane.children[pane.root] === undefined
  useEffect(() => {
    if (rootMissing && !pane.loading && pane.loadingPaths.length === 0) {
      useSftpStore.getState().refresh(hostId)
    }
  }, [rootMissing, pane.loading, pane.loadingPaths, hostId])

  /** 自愈 2/3：数据非空但树渲染 0 行（内部状态损坏）→ 限次整树重挂载；尺寸卡 0 → 直接重测 */
  useEffect(() => {
    const api = treeRef.current
    if (size.h === 0) {
      const el = wrapRef.current
      if (el && el.clientHeight > 0) setSize({ w: el.clientWidth, h: el.clientHeight })
      return
    }
    if (!api) return
    if (api.visibleNodes.length > 0) {
      healAttempts.current = 0
      return
    }
    if (data.length > 0 && healAttempts.current < 3) {
      healAttempts.current += 1
      setTreeNonce((n) => n + 1)
    }
  }, [data, size.h, treeNonce])

  /** 展开：store 为真源，reveal/路径跳转等程序化展开在这里对齐到树（含自愈重挂载后） */
  const expandedKey = pane.expanded.join('\n')
  useEffect(() => {
    const api = treeRef.current
    if (!api) return
    const want = new Set(pane.expanded)
    for (const id of pane.expanded) if (!api.isOpen(id)) api.open(id)
    for (const [id, open] of Object.entries(api.openState)) {
      if (open && !want.has(id)) api.close(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedKey, size.h, treeNonce])

  /** 选中：删除等外部变更后与树内部选中集对齐 */
  const selectedKey = selected.join('\n')
  useEffect(() => {
    const api = treeRef.current
    if (!api) return
    const cur = api.selectedIds
    if (cur.size === selected.length && selected.every((p) => cur.has(p))) return
    if (selected.length === 0) {
      api.deselectAll()
      return
    }
    api.setSelection({
      ids: selected,
      anchor: selected[0],
      mostRecent: selected[selected.length - 1]
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, size.h, treeNonce])

  /** reveal/新建/移动后的定位：滚动到并选中 */
  const focused = pane.focusedPath
  useEffect(() => {
    const api = treeRef.current
    if (!api || !focused || !api.get(focused)) return
    api.select(focused, { focus: true })
    void api.scrollTo(focused)
  }, [focused, size.h, treeNonce])

  /** 树内展开变化（含命令式 open 触发）→ 仅当与 store 状态不一致时同步，防回环 */
  const onToggle = useCallback(
    (id: string) => {
      const api = treeRef.current
      if (!api || id.endsWith(EMPTY_SUFFIX)) return
      const entry = entryByPath(pane, id)
      if (!entry?.isDir) return
      if (api.isOpen(id) !== pane.expanded.includes(id)) {
        useSftpStore.getState().toggle(hostId, entry)
      }
    },
    [pane, hostId]
  )

  /** Enter 激活：目录展开，文件打开（鼠标走行级双击） */
  const handleActivate = useCallback(
    (node: NodeApi<TreeDatum>) => {
      const entry = node.data.entry
      if (!entry) return
      if (entry.isDir) node.toggle()
      else actions.onOpenFile(entry)
    },
    [actions]
  )

  const handleSelect = useCallback(
    (nodes: NodeApi<TreeDatum>[]) => {
      onSelectedChange(
        nodes.filter((n) => !n.data.placeholder && n.data.errorMsg === undefined).map((n) => n.id)
      )
    },
    [onSelectedChange]
  )

  /** 删除仅经右键菜单/工具栏入口（带确认弹窗）；不设 Delete/Backspace 快捷键，防止误操作 */

  /** 空目录占位行不可选中；库自带拖拽整体禁用（内部移动走自建原生拖拽层） */
  // 占位节点（空目录/列目录错误行）不可选中：假路径不得进入选择集与右键操作
  const disableSelect = useCallback(
    (d: TreeDatum) => d.placeholder === true || d.errorMsg !== undefined,
    []
  )

  /** 外部文件拖入：定位目标目录（占位行落在其父目录上） */
  const dropDirFromTarget = (target: EventTarget | null): string => {
    const row = (target as HTMLElement | null)?.closest?.('[data-sftp-path]')
    const path = row?.getAttribute('data-sftp-path')
    if (!path) return pane.root
    const e = entryByPath(pane, path)
    if (!e) return pane.root
    return e.isDir ? e.path : parentPath(e.path)
  }

  return (
    <TreeContext.Provider value={ctxValue}>
      <div
        ref={wrapRef}
        className="relative min-h-0 flex-1"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            setDropArmed(true)
            const dir = dropDirFromTarget(e.target)
            setOverDir(dir)
            springDir(dir) // 外部文件拖入同样 spring-loading
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setDropArmed(false)
            setOverDir(null)
            clearSpring()
          }
        }}
        onDrop={(e) => {
          setDropArmed(false)
          setOverDir(null)
          clearSpring()
          if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return
          e.preventDefault()
          const paths: string[] = []
          for (const f of Array.from(e.dataTransfer.files)) {
            paths.push(window.aterm.sftp.pathForFile(f))
          }
          if (paths.length > 0) actions.onUploadPaths(paths, dropDirFromTarget(e.target))
        }}
      >
        {dropArmed && (
          <div className="pointer-events-none absolute inset-2 z-10 rounded-lg border-[1.5px] border-dashed border-at-accent/80 bg-at-accent/5" />
        )}

        {size.h > 0 && (
          <Tree<TreeDatum>
            key={treeNonce}
            ref={treeRef}
            data={data}
            width="100%"
            height={size.h}
            rowHeight={24}
            indent={14}
            overscanCount={8}
            openByDefault={false}
            disableEdit
            disableDrag
            disableSelect={disableSelect}
            onToggle={onToggle}
            onActivate={handleActivate}
            onSelect={handleSelect}
            renderCursor={NullCursor}
            className="outline-none"
            aria-label={t('sftp.treeAria')}
            renderRow={SftpRow}
          >
            {SftpNode}
          </Tree>
        )}
      </div>
    </TreeContext.Provider>
  )
}

/** 行容器：单击选中（⌘/⇧ 多选）/ 双击激活；右键菜单；内部拖拽原生自实现；占位行可作落点 */
function SftpRow({
  node,
  attrs,
  innerRef,
  children
}: RowRendererProps<TreeDatum>): React.JSX.Element {
  const { actions, onRowDragStart, onRowDragOver, onRowDrop, onRowDragEnd } =
    useContext(TreeContext)
  const entry = node.data.entry

  if (!entry) {
    return (
      <div
        {...attrs}
        ref={innerRef}
        data-sftp-path={node.parent?.id}
        className="flex h-full items-center"
        onFocus={(e) => e.stopPropagation()}
        onDragOver={(e) => onRowDragOver(e, node)}
        onDrop={(e) => onRowDrop(e, node)}
      >
        {children}
      </div>
    )
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          {...attrs}
          ref={innerRef}
          data-sftp-path={entry.path}
          title={entry.path}
          className="outline-none"
          draggable
          onFocus={(e) => e.stopPropagation()}
          onDragStart={(e) => onRowDragStart(e, node)}
          onDragOver={(e) => onRowDragOver(e, node)}
          onDrop={(e) => onRowDrop(e, node)}
          onDragEnd={onRowDragEnd}
          onClick={(e) => {
            if (e.detail >= 2) return // 双击走 onDoubleClick
            if (e.metaKey || e.ctrlKey) {
              if (node.isSelected) node.deselect()
              else node.selectMulti()
            } else if (e.shiftKey) {
              node.selectContiguous()
            } else {
              node.select()
            }
          }}
          onDoubleClick={() => {
            node.select()
            if (entry.isDir) node.toggle()
            else actions.onOpenFile(entry)
          }}
          onContextMenu={() => {
            if (!node.isSelected) node.select()
          }}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <RowMenu entry={entry} actions={actions} />
    </ContextMenu>
  )
}

/** 行内容：箭头位（loading 换转圈）/图标位/名称 */
function SftpNode({ node, style, dragHandle }: NodeRendererProps<TreeDatum>): React.JSX.Element {
  const { t } = useTranslation()
  const { hostId, overDir, actions } = useContext(TreeContext)
  const entry = node.data.entry
  const loading = useSftpStore((s) => {
    const p = s.panes[hostId]
    return entry?.isDir === true && p !== undefined && p.loadingPaths.includes(entry.path)
  })

  /** 层级参考线：每个祖先层级一条竖线，x 对齐该层箭头槽中心（indent=14 → i*14+16） */
  const guides =
    node.level > 0
      ? Array.from({ length: node.level }, (_, i) => (
          <span
            key={i}
            className="pointer-events-none absolute inset-y-0 w-px bg-muted/25"
            style={{ left: i * 14 + 16 }}
          />
        ))
      : null

  if (node.data.errorMsg !== undefined) {
    return (
      <div
        style={{ ...style, paddingLeft: Number(style.paddingLeft ?? 0) + 8 }}
        className="relative flex h-full select-none items-center gap-1 pr-2"
      >
        {guides}
        <span className="w-4 shrink-0" />
        <span className="flex w-4 shrink-0 justify-center">
          <Folder
            size={13}
            strokeWidth={1.5}
            className="text-danger/85"
            style={{ strokeDasharray: '2.5 2' }}
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-minor text-danger" title={node.data.errorMsg}>
          {node.data.errorMsg}
        </span>
      </div>
    )
  }

  if (!entry) {
    return (
      <div
        style={{ ...style, paddingLeft: Number(style.paddingLeft ?? 0) + 8 }}
        className="relative flex h-full select-none items-center gap-1 pr-2"
      >
        {guides}
        <span className="w-4 shrink-0" />
        <span className="flex w-4 shrink-0 justify-center">
          <span className="h-[13px] w-[13px] rounded-[3px] border border-dashed border-muted/45" />
        </span>
        <span className="min-w-0 flex-1 truncate text-minor text-muted/60">
          {t('sftp.emptyDir')}
        </span>
      </div>
    )
  }

  const expanded = node.isOpen
  const isSelected = node.isSelected
  /** 高亮 = 落点目录整块子树（内部移动与外部文件拖入共用 overDir；非法与同目录 no-op 无高亮） */
  const isDropTarget =
    overDir !== null && (entry.path === overDir || entry.path.startsWith(`${overDir}/`))
  const fv = fileVisual(entry.name)

  return (
    <div
      ref={dragHandle}
      style={{ ...style, paddingLeft: Number(style.paddingLeft ?? 0) + 8 }}
      className={cn(
        'group relative flex h-full w-full cursor-pointer select-none items-center gap-1 pr-2 transition-colors duration-75',
        isDropTarget ? 'bg-at-accent/15' : isSelected ? 'bg-hover' : 'hover:bg-hover/70'
      )}
    >
      {guides}
      <span
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center',
          entry.isDir ? 'text-muted' : 'pointer-events-none opacity-0'
        )}
      >
        {entry.isDir ? (
          loading ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <button
              type="button"
              tabIndex={-1}
              className="flex h-4 w-4 items-center justify-center rounded-sm hover:text-fg"
              onClick={(e) => {
                e.stopPropagation()
                e.preventDefault()
                node.toggle()
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <ChevronRight
                size={12}
                strokeWidth={2.4}
                className={cn('transition-transform duration-100', expanded && 'rotate-90')}
              />
            </button>
          )
        ) : null}
      </span>
      <span className="pointer-events-none flex w-4 shrink-0 justify-center">
        {entry.isLink ? (
          <Link2 size={12} strokeWidth={2} className="text-muted" />
        ) : entry.isDir ? (
          expanded ? (
            <FolderOpen size={13} strokeWidth={1.5} className="fill-current text-warn" />
          ) : (
            <Folder size={13} strokeWidth={1.5} className="fill-current text-warn" />
          )
        ) : (
          <fv.icon size={12.5} strokeWidth={2} className={fv.cls} />
        )}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-minor outline-none',
          isSelected ? 'font-medium text-fg' : 'text-muted'
        )}
      >
        {entry.name}
        {entry.linkTarget ? (
          <span className="text-caption text-muted/70"> -&gt; {entry.linkTarget}</span>
        ) : null}
      </span>
      <IconButton
        icon={Bot}
        frame={20}
        title={t('sftp.sendToAi')}
        className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          actions.onSendToAi(entry)
        }}
      />
    </div>
  )
}

/** 右键菜单（扁平化 + 分组：打开/新建 → 上传 → 传输/整理 → 复制/终端/信息 → 删除） */
function RowMenu({
  entry,
  actions
}: {
  entry: SftpEntry
  actions: SftpTreeActions
}): React.JSX.Element {
  const { t } = useTranslation()
  const dir = entry.isDir ? entry.path : parentPath(entry.path)
  return (
    <ContextMenuContent className="w-44 border-line">
      <ContextMenuItem onClick={() => actions.onSendToAi(entry)}>
        <Bot />
        {t('sftp.sendToAi')}
      </ContextMenuItem>
      {!entry.isDir && (
        <ContextMenuItem onClick={() => actions.onOpenFile(entry)}>
          <SquarePen />
          {t('sftp.openInEditor')}
        </ContextMenuItem>
      )}
      {/* 创建目标：目录行=其内部；文件行=其所在目录 */}
      <ContextMenuItem onClick={() => actions.onNewFile(dir)}>
        <FilePlus />
        {t('sftp.newFile')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.onMkdir(dir)}>
        <FolderPlus />
        {t('sftp.newFolder')}
      </ContextMenuItem>
      {entry.isDir && (
        <>
          <ContextMenuItem onClick={() => actions.onUploadFiles(entry.path)}>
            <Upload />
            {t('sftp.uploadFilesHere')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => actions.onUploadFolders(entry.path)}>
            <FolderUp />
            {t('sftp.uploadFoldersHere')}
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator className="bg-line" />
      <ContextMenuItem onClick={() => actions.onDownload(entry)}>
        <Download />
        {t('common.download')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.onMoveTo(entry)}>
        <FolderInput />
        {t('sftp.moveToEllipsis')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.onRename(entry)}>
        <Pencil />
        {t('common.rename')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.onChmod(entry)}>
        <KeyRound />
        {t('sftp.permissionsEllipsis')}
      </ContextMenuItem>
      <ContextMenuSeparator className="bg-line" />
      <ContextMenuItem onClick={() => actions.onCopyName(entry)}>
        <Copy />
        {t('sftp.copyName')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.onCopyPath(entry)}>
        <ClipboardCopy />
        {t('sftp.copyPath')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.onOpenTerminal(dir)}>
        <SquareTerminal />
        {t('sftp.openTerminalHere')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.onInfo(entry)}>
        <Info />
        {t('sftp.showInfo')}
      </ContextMenuItem>
      <ContextMenuSeparator className="bg-line" />
      <ContextMenuItem variant="destructive" onClick={() => actions.onDelete([entry])}>
        <Trash2 />
        {t('common.delete')}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
