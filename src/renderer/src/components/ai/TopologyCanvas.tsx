import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Circle, FolderTree, ListTree, Sparkles, Waypoints } from 'lucide-react'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  BaseEdge,
  getStraightPath,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useTranslation } from 'react-i18next'
import { siGithubcopilot } from 'simple-icons'
import { groupChain } from '@shared/groupTree'
import { Button } from '@/components/form/Buttons'
import { OsIcon } from '@/components/connection/OsIcon'
import { IconButton } from '@/components/ui/IconButton'
import { hexToCss } from '@/lib/theme'
import { useConnectionsStore } from '@/stores/connections'
import { useSessionStore } from '@/stores/session'
import {
  useTopologyGraph,
  type DisplayState,
  type EdgeState,
  type TopoEdgeData,
  type TopoNodeData
} from './topology/useTopologyGraph'

/**
 * AI 作业拓扑画布（React Flow）——状态可视化层。
 *
 * 视觉语言（全局唯一约定，不允许在别处另起一套）：
 *   颜色：绿 = 此刻已连接 / 琥珀 = 进行中 / 红 = 连接失败 / 灰 = 已断开
 *   动效：流动虚线 = 正在建链 · 数据包流光 = 已连且正在操作 · 旋转虚线环 = 握手中
 *         呼吸光环 = AI 正在对本机操作 · 外圈进度环 = 断开已多久（走完即淡出退场）
 *   审批：操作在等人工确认时，数据包流光与呼吸光环一并转琥珀（与审批卡黄框同语义）——
 *         线型与线宽跟默认操作态一致，只换颜色 + 加强光晕，免得与「正在建链」的流动虚线撞语义；
 *         审批叠加的判定见 topology/useTopologyGraph.ts。
 *   信息密度：原因/次数/断开时刻等细节只在点击节点后的左下角气泡出现，不占用常驻视觉
 *   点击聚焦：被点节点的连线抬到无关节点之上（但仍低于自己的两端节点），其余节点与边淡化
 *   选中：被点节点图标放大一档 + host 标签加粗提亮（不动圆环颜色与尺寸，避开状态色语义）
 *
 * 两轴状态模型见 topology/useTopologyGraph.ts（链路 / 活动 → 单一展示态投影）。
 */

/** 视图偏好（滑杆），localStorage 持久化 */
const VIEW_KEY = 'ggterm.topology'
const SPACING_MIN = 0.4
const SPACING_MAX = 2
const SIZE_MIN = 0.6
const SIZE_MAX = 1.6

/** 断开倒计时环周长（SVG viewBox 100、r=48），与 CSS topo-countdown 的 302 对齐 */
const RING_LEN = 302

/**
 * 布局重排动画时长：位移不走 CSS transition，而是在 JS 里逐帧插值。
 * 因为节点与连线用的是同一份坐标，逐帧更新天然同步 —— 不会出现「线已跳到新位置、圆还在飘」。
 */
const MOVE_MS = 550

/** 缓动（ease-in-out）；无需与 CSS 对齐，位移已完全由 JS 驱动 */
function easeInOut(t: number): number {
  return 1 - (1 - t) ** 3
}

/** 系统「减少动效」偏好：直接切到目标位置，不做插值 */
function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function loadViewPrefs(): { spacing: number; nodeSize: number } {
  try {
    const raw = localStorage.getItem(VIEW_KEY)
    if (raw) {
      const p = JSON.parse(raw) as { spacing?: number; nodeSize?: number }
      return {
        spacing: Math.min(SPACING_MAX, Math.max(SPACING_MIN, p.spacing ?? 1)),
        nodeSize: Math.min(SIZE_MAX, Math.max(SIZE_MIN, p.nodeSize ?? 1))
      }
    }
  } catch {
    /* 损坏则回退默认 */
  }
  return { spacing: 1, nodeSize: 1 }
}

/** 主机节点圆底：浅灰（冷调，贴 AT 灰阶；仍不透明 —— 继续盖住圆心连线的线头） */
const HOST_FILL = '#d7d7d7'
/** 已断开弱化圆底：同色降透明度，保持「灰环 + 图标去饱和 = 退到背景层」的语义 */
const HOST_FILL_CLOSED = 'rgb(213 217 222 / 0.45)'

/**
 * 展示态 → 节点视觉（唯一映射表）。
 * ring = 圆环/连线色；spin = 握手旋转环周期秒数（0 = 无）；dim = 图标去饱和（已断开退到背景层）；
 * fill = 节点圆底（浅灰：品牌色 OS 图标清晰，且不透明以盖住圆心连线的线头）
 */
const NODE_LOOK: Record<DisplayState, { ring: string; spin: number; dim: boolean; fill: string }> =
  {
    healthy: { ring: 'var(--at-ok)', spin: 0, dim: false, fill: HOST_FILL },
    dialing: { ring: 'var(--at-warn)', spin: 2.4, dim: false, fill: HOST_FILL },
    retrying: { ring: 'var(--at-warn)', spin: 1.6, dim: false, fill: HOST_FILL },
    failed: { ring: 'var(--at-danger)', spin: 0, dim: false, fill: HOST_FILL },
    closed: { ring: 'var(--at-muted)', spin: 0, dim: true, fill: HOST_FILL_CLOSED }
  }

/** 圆心隐形挂点：边按圆心连圆心（不透明圆盖住线头，Obsidian 图谱观感），不可见、不可连线 */
function CircleHandles(): React.JSX.Element {
  const center = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' } as const
  const hidden = {
    ...center,
    width: 0,
    height: 0,
    minWidth: 0,
    border: 0,
    background: 'transparent'
  } as const
  return (
    <>
      <Handle type="source" position={Position.Top} isConnectable={false} style={hidden} />
      <Handle type="target" position={Position.Top} isConnectable={false} style={hidden} />
    </>
  )
}

/** 中心节点（本机）圆底：不透明深色（避免连线从半透明底透出），与白色主机节点区分主客 */
const CIRCLE_BG = 'rgb(20 23 26)' /* = --at-raised 去透明 */

/**
 * AI 操作光环（连线的同源信号）：操作中 = 蓝色呼吸；等人工审批 = 琥珀呼吸（与审批卡黄框同语义）；
 * 结束淡出时保持等待期的配色，但只走 fade-out —— 颜色不该在淡出途中再跳一次。
 */
function ringOf(data: TopoNodeData): { cls: string; border: string } {
  const border = data.pending ? 'border-warn' : 'border-info'
  if (data.settling) return { cls: 'topo-ring-settling', border }
  return { cls: data.pending ? 'topo-ring-pending' : 'topo-ring-active', border }
}

/** 时刻 → HH:mm:ss（断开/失败发生点） */
function clockOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 外圈倒计时环：环从满到空 = 断开已多久。
 * 用负 animation-delay 对齐已流逝时间 —— 刷新/重进页面接续原进度，不重置。
 */
function CountdownRing({ since, color }: { since: number; color: string }): React.JSX.Element {
  const ref = useRef<SVGCircleElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.style.animationDelay = `-${((Date.now() - since) / 1000).toFixed(1)}s`
  }, [since])
  return (
    <svg className="pointer-events-none absolute -inset-3" viewBox="0 0 100 100" aria-hidden="true">
      <circle
        ref={ref}
        className="topo-countdown-ring"
        cx="50"
        cy="50"
        r="48"
        fill="none"
        stroke={color}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={RING_LEN}
        transform="rotate(-90 50 50)"
        style={{ opacity: 0.45 }}
      />
    </svg>
  )
}

/** 主机节点：OS 图标 + 名称；圆环颜色即状态，细节在左下角气泡（点击节点后出现） */
function HostNode({ data }: NodeProps<Node<TopoNodeData>>): React.JSX.Element {
  const look = NODE_LOOK[data.state]
  const ring = ringOf(data)
  const d = (data.jump ? 26 : 34) * data.sizeK
  return (
    <div
      className={`flex cursor-pointer flex-col items-center${
        data.leaving ? ' topo-node-leaving' : ''
      }`}
    >
      <div className="relative" style={{ width: d, height: d }}>
        <CircleHandles />

        {/* 外圈：断开倒计时（走完即整节点淡出退场） */}
        {data.ringSince != null && <CountdownRing since={data.ringSince} color={look.ring} />}

        {/* 中圈：握手旋转虚线环（建连/重连/测试中） */}
        {look.spin > 0 && (
          <span
            className="topo-ring-state pointer-events-none absolute -inset-2 rounded-full border border-dashed"
            style={{ borderColor: look.ring, animationDuration: `${look.spin}s` }}
          />
        )}

        {/* 内圈：AI 操作呼吸光环（进入淡入，结束淡出后再移除；等人工审批时转琥珀） */}
        {data.active && (
          <span
            className={`${ring.cls} pointer-events-none absolute -inset-1 rounded-full border ${ring.border}`}
          />
        )}

        <div
          className="flex h-full w-full items-center justify-center rounded-full border transition-colors duration-300"
          style={{ background: look.fill, borderColor: look.ring }}
        >
          <span
            className="topo-icon"
            style={
              {
                '--topo-icon-k': data.sizeK,
                filter: look.dim ? 'saturate(0.2) opacity(0.75)' : undefined
              } as React.CSSProperties
            }
          >
            <OsIcon osName={data.osName} onLight />
          </span>
        </div>

        {/* 标签脱离文档流（挂在圆上）：节点尺寸只由圆决定，加粗或换名称都不会挪动圆心 */}
        <span className="topo-node-label absolute top-full left-1/2 mt-0.5 max-w-24 -translate-x-1/2 truncate text-caption text-muted">
          {data.label}
        </span>
      </div>
    </div>
  )
}

/**
 * 左下角气泡：点击节点后常驻显示完整信息（地址 / 分组 / 状态 / 重试次数 / 失败原因 / 断开时刻），
 * 并提供「连接主机」—— 与连接列表那个「连接」按钮同一个入口（useSessionStore.connect），
 * 建链失败会由链路事件回灌成节点红态，所以这里不再单独弹错误。
 * 取代原来的 hover 悬浮浮层 —— 信息不再跟着鼠标跑，也不会被画布内容挤掉。
 */
function NodeBubble({ data }: { data: TopoNodeData }): React.JSX.Element {
  const { t } = useTranslation()
  const look = NODE_LOOK[data.state]
  const { address, attempt, reason, since } = data.detail
  /** 上图主机都来自已保存的连接（跳板中间节点也是），配置取得到才允许发起连接 */
  const conn = useConnectionsStore((s) => s.connections.find((c) => c.id === data.hostId))
  const groups = useConnectionsStore((s) => s.groups)
  const connect = useSessionStore((s) => s.connect)
  /**
   * 所属分组：从所在分组递归到根（父 → 子），与连接列表侧栏同一套目录链；
   * 未分组或配置已删除时退化到单一标签，不做「缺失」的额外分支。
   */
  const chain = conn?.groupId ? groupChain(conn.groupId, groups) : []
  const groupText = chain.length ? chain.map((g) => g.name).join(' / ') : t('conn.ungrouped')
  const groupColor = chain.length ? hexToCss(chain[chain.length - 1].colorHex) : 'var(--at-muted)'
  return (
    <div className="absolute bottom-3 left-3 z-10 w-max max-w-72 rounded-lg border border-line bg-raised/90 px-2.5 py-2 backdrop-blur">
      <div className="text-body text-fg">{data.label}</div>
      {address && <div className="mt-0.5 font-mono text-caption text-muted">{address}</div>}
      <div
        className="mt-0.5 flex items-center gap-1.5"
        title={t('ai.topo.group', { name: groupText })}
      >
        <FolderTree size={11} strokeWidth={2} className="shrink-0" style={{ color: groupColor }} />
        <span className="min-w-0 truncate text-caption text-muted">{groupText}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: look.ring }} />
        <span className="text-caption text-muted">{t(`ai.topo.state.${data.state}`)}</span>
      </div>
      {attempt != null && (
        <div className="mt-0.5 text-caption text-warn">
          {t('ai.topo.attempt', { n: attempt })}
        </div>
      )}
      {reason && <div className="mt-0.5 text-caption break-words text-danger/90">{reason}</div>}
      {since != null && (
        <div className="mt-0.5 text-caption text-muted/80">
          {t('ai.topo.since')} {clockOf(since)}
        </div>
      )}
      <div className="mt-2 flex justify-end">
        <Button
          size="sm"
          title={t('ai.topo.connect')}
          disabled={!conn}
          onClick={() => {
            if (conn) void connect(conn).catch(() => undefined)
          }}
        />
      </div>
    </div>
  )
}

/** 中心节点：本机 + AI 图标；本机操作时呼吸光环 */
function CenterNode({ data }: NodeProps<Node<TopoNodeData>>): React.JSX.Element {
  const { t } = useTranslation()
  const ring = ringOf(data)
  const d = 46 * data.sizeK
  return (
    <div className="flex cursor-default flex-col items-center">
      <div className="relative" style={{ width: d, height: d }}>
        <CircleHandles />
        {data.active && (
          <span
            className={`${ring.cls} pointer-events-none absolute -inset-1 rounded-full border ${ring.border}`}
          />
        )}
        <div
          className="flex h-full w-full items-center justify-center rounded-full border transition-colors duration-300"
          style={{ background: CIRCLE_BG, borderColor: 'var(--at-info)' }}
        >
          <svg width={d * 0.46} height={d * 0.46} viewBox="0 0 24 24" role="img" aria-hidden="true">
            <path d={siGithubcopilot.path} fill="var(--at-info)" />
          </svg>
        </div>

        <span className="absolute top-full left-1/2 mt-0.5 -translate-x-1/2 text-caption text-muted">
          {t('ai.topo.local')}
        </span>
      </div>
    </div>
  )
}

/** 拓扑边：直线（圆心连圆心）+ 状态样式类；working/pending 各叠一层数据包流光 */
function TopoEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data
}: EdgeProps<Edge<TopoEdgeData>>): React.JSX.Element {
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY })
  const state: EdgeState = data?.state ?? 'closed'
  const leaving = data?.leaving ?? false
  const gradientId = `topo-${useId().replace(/:/g, '')}`
  // pending 走 CSS 里的琥珀实色（不套渐变）：等审批要一眼分辨，不能再掺青色进去
  const colorful = state === 'working' || state === 'healthy'
  const stroke = colorful ? `url(#${gradientId})` : undefined
  return (
    <>
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={sourceX}
          y1={sourceY}
          x2={targetX}
          y2={targetY}
        >
          <stop offset="0%" stopColor="var(--at-info)" />
          <stop offset="55%" stopColor="var(--at-ok)" />
          <stop offset="100%" stopColor="var(--at-ok)" />
        </linearGradient>
      </defs>
      <BaseEdge
        id={id}
        path={path}
        className={`topo-edge topo-edge-${state}${leaving ? ' topo-edge-leaving' : ''}`}
        style={{ stroke }}
      />
      {state === 'working' && !leaving && (
        <path d={path} className="topo-packet" style={{ stroke }} />
      )}
      {state === 'pending' && !leaving && <path d={path} className="topo-packet topo-packet-pending" />}
    </>
  )
}

/** nodeTypes/edgeTypes 必须模块级稳定（RF #002：组件内新建对象会触发重挂载告警）。
 * memo 的比较器只看真正参与渲染的字段：位置由 RF 外层容器驱动、不经过本组件，
 * 因此链路状态/活动未变时，整棵节点子树与边的 SVG 都不重渲染。
 */
const NODE_TYPES = {
  host: memo(HostNode, (a, b) => a.data === b.data),
  center: memo(CenterNode, (a, b) => a.data === b.data)
}
const EDGE_TYPES = {
  topo: memo(
    TopoEdge,
    (a, b) =>
      a.id === b.id &&
      a.data === b.data &&
      a.sourceX === b.sourceX &&
      a.sourceY === b.sourceY &&
      a.targetX === b.targetX &&
      a.targetY === b.targetY
  )
}

/** 图例行：六种链路展示态 + 两个活动叠加态（working 操作中 / pending 等人工审批） */
const LEGEND_ROWS: EdgeState[] = [
  'healthy',
  'working',
  'pending',
  'dialing',
  'retrying',
  'failed',
  'closed'
]

/** 图例色样：与真实边共用同一套 CSS 类，杜绝图例与实际表现漂移 */
function LegendSwatch({ k }: { k: EdgeState }): React.JSX.Element {
  return (
    <svg width={18} height={8} className="shrink-0" aria-hidden="true">
      <line x1={0} y1={4} x2={18} y2={4} className={`topo-edge topo-edge-${k}`} />
    </svg>
  )
}

function TopologyInner(): React.JSX.Element {
  const { t } = useTranslation()
  const { fitView } = useReactFlow()
  const [spacing, setSpacing] = useState(() => loadViewPrefs().spacing)
  const [nodeSize, setNodeSize] = useState(() => loadViewPrefs().nodeSize)
  const [legendOpen, setLegendOpen] = useState(false)
  const [layoutVersion, setLayoutVersion] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const { nodes, edges } = useTopologyGraph(spacing, nodeSize)
  /** 被点击的节点：它的连线置顶、其余淡化；再点一次或点空白处取消 */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** 节点退场被移除后视为未选中（由 nodes 派生，不需要额外的清理副作用） */
  const selected = selectedId !== null && nodes.some((n) => n.id === selectedId) ? selectedId : null

  /** RF 受控节点状态：applyNodeChanges 完整回灌（含 measured 内部量，防 #015 未初始化告警） */
  const [displayNodes, setDisplayNodes] = useState<Node<TopoNodeData>[]>(nodes)
  /** 最新受控节点：供 effect 读取（避免闭包过期；拖拽/动画中间态都在这里） */
  const displayRef = useRef<Node<TopoNodeData>[]>(nodes)
  const draggedRef = useRef(new Set<string>()) // 用户拖拽过的节点 id（布局更新时保持其位置）
  const spacingPrev = useRef(spacing)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    displayRef.current = displayNodes
  }, [displayNodes])

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    },
    []
  )

  /**
   * 布局变化 → 逐帧插值把节点移到新位置。
   * 两个关键点：
   *  ① measured 必须保留 —— 丢了会让 RF 重新测量节点，表现为连线短暂错位/闪烁；
   *  ② 拖拽中的节点完全交给指针（每帧取最新显示值），动画不插手，避免与拖拽互相打架。
   */
  useEffect(() => {
    const spacingChanged = spacingPrev.current !== spacing
    spacingPrev.current = spacing
    if (spacingChanged) draggedRef.current.clear()

    const curr = new Map(displayRef.current.map((n) => [n.id, n]))
    const merged = nodes.map((n) => {
      const old = curr.get(n.id)
      if (!old) return n
      const keepPos = !spacingChanged && draggedRef.current.has(n.id)
      const position = keepPos ? old.position : n.position
      // 数据与位置都未变：沿用上一轮对象（受控数组元素身份稳定 → RF 不做任何重渲染）
      if (
        old.data === n.data &&
        old.position.x === position.x &&
        old.position.y === position.y &&
        old.measured
      )
        return old
      return { ...n, measured: old.measured, position }
    })

    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    const from = new Map(merged.map((n) => [n.id, curr.get(n.id)?.position ?? n.position]))
    const to = new Map(merged.map((n) => [n.id, n.position]))
    const moved = merged.some((n) => {
      const a = from.get(n.id)
      return a !== undefined && (a.x !== n.position.x || a.y !== n.position.y)
    })
    if (!moved || prefersReducedMotion()) {
      // 元素逐个全等（身份未变）时跳过 setState，避免一次无意义的整图重渲染
      const shown = displayRef.current
      if (merged.length === shown.length && merged.every((n, i) => n === shown[i])) return
      setDisplayNodes(merged)
      return
    }

    const t0 = performance.now()
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / MOVE_MS)
      const k = easeInOut(p)
      setDisplayNodes((prev) => {
        const prevById = new Map(prev.map((n) => [n.id, n]))
        return merged.map((n) => {
          if (draggedRef.current.has(n.id)) return prevById.get(n.id) ?? n
          const a = from.get(n.id) ?? n.position
          const b = to.get(n.id) ?? n.position
          return { ...n, position: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k } }
        })
      })
      rafRef.current = p < 1 ? requestAnimationFrame(step) : null
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [nodes, spacing, layoutVersion])

  const onNodesChange = useCallback((changes: NodeChange<Node<TopoNodeData>>[]) => {
    setDisplayNodes((curr) => {
      const next = applyNodeChanges<Node<TopoNodeData>>(changes, curr)
      for (const c of changes) {
        if (c.type === 'position' && c.dragging) draggedRef.current.add(c.id)
      }
      return next
    })
  }, [])

  const changeView = (key: 'spacing' | 'nodeSize', value: number): void => {
    if (key === 'spacing') setSpacing(value)
    else setNodeSize(value)
    const prefs = {
      spacing: key === 'spacing' ? value : spacing,
      nodeSize: key === 'nodeSize' ? value : nodeSize
    }
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(prefs))
    } catch {
      /* 忽略 */
    }
  }

  // 仅结构/尺寸变化触发布局收纳；链路状态、性能采样和工具事件不抢用户视角。
  const structureKey = useMemo(
    () => JSON.stringify([nodes.map((n) => n.id).sort(), edges.map((e) => e.id).sort()]),
    [nodes, edges]
  )
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const schedule = (): void => {
      clearTimeout(timer)
      timer = setTimeout(
        () => {
          const container = containerRef.current
          if (!container || !container.clientWidth || !container.clientHeight) return
          void fitView({ padding: 0.25, duration: prefersReducedMotion() ? 0 : 450, maxZoom: 1.6 })
        },
        prefersReducedMotion() ? 50 : MOVE_MS + 80
      )
    }
    schedule()
    const observer = new ResizeObserver(schedule)
    if (containerRef.current) observer.observe(containerRef.current)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [structureKey, spacing, nodeSize, layoutVersion, fitView])

  /**
   * 聚焦投影（层级从高到低）：被点节点 2000 → 边的另一端节点 1600 → 它的入边/出边 1500 → 其余节点与边 0（淡化）。
   * 连线两端都高于连线，抬高的线才不会横穿另一端的圆；连线又高于无关节点，所以照样看得见。
   * 本机是参照点，不淡化。
   */
  const { viewNodes, viewEdges } = useMemo(() => {
    if (!selected) return { viewNodes: displayNodes, viewEdges: edges }
    const near = new Set<string>([selected])
    for (const e of edges) {
      if (e.source === selected || e.target === selected) near.add(e.source).add(e.target)
    }
    return {
      viewNodes: displayNodes.map((n) => {
        if (n.id === selected) return { ...n, zIndex: 2000, className: 'topo-selected' }
        if (near.has(n.id)) return { ...n, zIndex: 1600 }
        return n.id === 'CENTER' ? n : { ...n, className: 'topo-dim' }
      }),
      viewEdges: edges.map((e) =>
        e.source === selected || e.target === selected
          ? { ...e, zIndex: 1500, className: 'topo-elevated' }
          : { ...e, className: 'topo-dim' }
      )
    }
  }, [displayNodes, edges, selected])

  /** 气泡数据取实时投影（链路状态更新时气泡跟着变），节点退场即自然消失 */
  const selectedNode = selected ? nodes.find((n) => n.id === selected) : undefined

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node<TopoNodeData>): void => {
    // 只有主机节点进气泡；本机（center）点击视为取消，再点同一节点也是取消
    setSelectedId((cur) => (node.type === 'host' && cur !== node.id ? node.id : null))
  }, [])

  const onPaneClick = useCallback((): void => setSelectedId(null), [])

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <ReactFlow
        nodes={viewNodes}
        edges={viewEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1.6 }}
        minZoom={0.3}
        maxZoom={2.5}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--at-line)" />
      </ReactFlow>

      {/* 左下角：被点节点的详情气泡（点击节点出现，取代原来的 hover 浮层） */}
      {selectedNode && <NodeBubble data={selectedNode.data} />}

      {/* 右下角：视图调节（连线间距 / 节点尺寸 / 自动缩放）与图例收在同一个面板里 */}
      <div className="absolute right-3 bottom-3 z-10 flex w-max flex-col items-stretch gap-2">
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-raised/90 px-2.5 py-2 backdrop-blur">
          {/* 图例：可折叠，默认收起（状态色语义需要时再看） */}
          {legendOpen && (
            <>
              <div className="text-caption text-muted">{t('ai.topo.legendTitle')}</div>
              <ul className="flex flex-col gap-1">
                {LEGEND_ROWS.map((k) => (
                  <li key={k} className="flex items-center gap-2">
                    <LegendSwatch k={k} />
                    <span className="text-caption text-fg/85">{t(`ai.topo.state.${k}`)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="flex items-center gap-2">
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2" title={t('ai.topo.spacing')}>
                <Waypoints size={12} strokeWidth={2} className="shrink-0 text-muted" />
                <input
                  type="range"
                  min={SPACING_MIN}
                  max={SPACING_MAX}
                  step={0.05}
                  value={spacing}
                  aria-label={t('ai.topo.spacing')}
                  onChange={(e) => changeView('spacing', Number(e.target.value))}
                  className="h-1 w-24 accent-(--at-accent)"
                />
              </label>
              <label className="flex items-center gap-2" title={t('ai.topo.nodeSize')}>
                <Circle size={12} strokeWidth={2} className="shrink-0 text-muted" />
                <input
                  type="range"
                  min={SIZE_MIN}
                  max={SIZE_MAX}
                  step={0.05}
                  value={nodeSize}
                  aria-label={t('ai.topo.nodeSize')}
                  onChange={(e) => changeView('nodeSize', Number(e.target.value))}
                  className="h-1 w-24 accent-(--at-accent)"
                />
              </label>
            </div>
            <IconButton
              variant="toolbar"
              icon={Sparkles}
              size={12}
              frame={22}
              cornerRadius={11}
              aria-label={t('ai.topo.fit')}
              title={t('ai.topo.fit')}
              onClick={() => {
                draggedRef.current.clear()
                setLayoutVersion((v) => v + 1)
              }}
            />
            <IconButton
              variant="toolbar"
              icon={ListTree}
              size={12}
              frame={22}
              cornerRadius={11}
              selected={legendOpen}
              aria-label={t('ai.topo.legendTitle')}
              title={t('ai.topo.legendTitle')}
              onClick={() => setLegendOpen((v) => !v)}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export function TopologyCanvas(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <TopologyInner />
    </ReactFlowProvider>
  )
}
