import { useEffect, useMemo, useRef, useState } from 'react'
import type { Edge, Node } from '@xyflow/react'
import type { HostConnection, HostLinkSnapshot, HostStateEvent, LinkPhase } from '@shared/types'
import { useConnectionsStore } from '@/stores/connections'
import { useLinksStore } from '@/stores/links'
import { usePerfStore } from '@/stores/perf'
import { layoutTopology } from './layout'

/**
 * AI 作业拓扑数据层：两轴正交状态 → 单一展示态投影 → React Flow nodes/edges。
 *
 * 两轴（互不派生，各自独立订阅）：
 *   ① 链路 links    —— 主进程 HostLink 是唯一权威（phase + 进入时刻 + 重试次数 + 失败原因）
 *   ② 活动 activity —— AI 工具执行中（叠加光环/数据包动效，可发生在建连期）
 *      活动上再叠一层「等人工审批」：审批卡未决期间连线/光环转琥珀（见 awaiting），
 *      人工审批写回后 sendAutomaticallyWhen 续跑 —— 新回合以 start 流片开篇，据此撤销待审批态。
 *
 * 上图规则（按需上图，不是资产全景）：
 * - 只画「本次运行内发生过连接动作」的主机（成功/失败/已断开都算，来源 = links 键集）；
 *   从未连接过的已保存资产不上图 —— 图始终是「本次作业地图」，主机再多也不拥挤
 * - 跳板链的中间节点必须一并上图（它没有自己的连接记录，否则链会断）
 * - 断开/失败：保留灰/红态 + 5 分钟倒计时环，环走完淡出移除；期间重连即撤销退场
 * - 折成链树后按径向树布局：跳板坐在自己下游节点的扇形中心，环半径按树深度递增；详见 layout.ts
 *
 * 不做「连接测试」态：测试不建立持久链路，主进程没有可持久的状态，上图只会造成
 * 刷新后结果消失的不一致 —— 测试结果由连接列表呈现。
 */

/** AI 操作脉动最短播放时长（快操作防闪烁） */
const PULSE_MIN_MS = 3000
/** 脉动淡出时长（与 CSS topo-fade-out 对齐） */
const PULSE_FADE_MS = 450
/** 断开/失败后倒计时环时长（与 CSS topo-countdown 300s 对齐）：环走完即淡出移除 */
const OFFLINE_RING_MS = 5 * 60 * 1000
/** 退场淡出时长（与 CSS topo-node-leaving 对齐） */
const LEAVE_FADE_MS = 450

/**
 * 展示态：两轴输入的唯一投影结果（唯一判定入口，优先级只在此处定义）。
 * - dialing  首次建连中  - retrying 重连中（带次数）  - healthy 已连接（绿 = 此刻可用）
 * - failed   重试超限失败 - closed   手动断开
 * AI 活动不产生独立展示态，而是叠加的 active 标记（正交轴）。
 */
export type DisplayState = 'dialing' | 'retrying' | 'healthy' | 'failed' | 'closed'

/**
 * 边视觉态：由链上目标的展示态 + 活动叠加派生。
 * - working 已连接且 AI 正在操作（蓝色数据包流光）
 * - pending 已连接且该操作在等人工审批（琥珀流光 + 呼吸光晕）—— 与审批卡黄框同语义
 */
export type EdgeState =
  | 'healthy'
  | 'working'
  | 'pending'
  | 'dialing'
  | 'retrying'
  | 'failed'
  | 'closed'

/** 处在「人工审批未决」状态的边视觉态权重（同一段边被多条链共享时取高者） */
const EDGE_ACT_RANK: Record<EdgeState, number> = {
  pending: 2,
  working: 1,
  healthy: 0,
  dialing: 0,
  retrying: 0,
  failed: 0,
  closed: 0
}

/** 状态聚合优先级（共享跳板节点/边取最优，数字小者胜） */
const STATE_RANK: Record<DisplayState, number> = {
  healthy: 0,
  dialing: 1,
  retrying: 2,
  closed: 3,
  failed: 4
}

/** hover 浮层的状态详情（绝对时间，避免渲染后过期） */
export interface NodeDetail {
  address?: string
  attempt?: number
  reason?: string
  /** 断开/失败发生的绝对时刻，展示为 HH:mm:ss */
  since?: number
}

export interface TopoNodeData extends Record<string, unknown> {
  /** 中心节点为 undefined */
  hostId?: string
  /** 连接名称（用户设置的显示名）；无连接记录时退化到 host / id 前缀 */
  label: string
  state: DisplayState
  /** AI 正在操作（叠加光环；链路上叠加数据包动效） */
  active: boolean
  /** 该主机上至少有一个工具调用在等人工审批（光环转琥珀呼吸；连线的数据包转琥珀） */
  pending: boolean
  /** 活动正在淡出（CSS 过渡） */
  settling: boolean
  /** 倒计时环走完、正在淡出（CSS topo-node-leaving） */
  leaving: boolean
  /** 中间跳板节点：尺寸更小 */
  jump: boolean
  sizeK: number
  osName: string
  detail: NodeDetail
  /** 倒计时环起点（failed/closed 才有值） */
  ringSince?: number
}

export interface TopoEdgeData extends Record<string, unknown> {
  state: EdgeState
  /** 目标已退场：连线同步淡出 */
  leaving: boolean
}

interface ActivityEntry {
  /** 并发中的工具数（同主机多工具时按最后一个结束收尾） */
  count: number
  /** 并发中「等人工审批」的工具数（>0 即琥珀态；审批决定后归零） */
  pending: number
  since: number
  /** 淡出中（CSS 过渡结束后移除） */
  settling: boolean
}

/** 退场进度：'out' = 正在淡出（节点保留） / 'gone' = 已移除（不再生成节点） */
type FadeStage = 'out' | 'gone'

/** 浅拷贝并剔除 key */
function withoutKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const next = { ...obj }
  delete next[key]
  return next
}

/* ---------------- 身份复用（避免状态高频变化引发全图重建） ---------------- */

/** 位置等价：布局缓存命中时是同一对象，这里兜底比数值 */
function samePos(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a === b || (a.x === b.x && a.y === b.y)
}

/** 节点数据等价（含 detail 各字段）：等价即复用同一对象，React Flow 据此跳过该节点 */
function sameNodeData(a: TopoNodeData, b: TopoNodeData): boolean {
  const x = a.detail
  const y = b.detail
  return (
    a.hostId === b.hostId &&
    a.label === b.label &&
    a.state === b.state &&
    a.active === b.active &&
    a.pending === b.pending &&
    a.settling === b.settling &&
    a.leaving === b.leaving &&
    a.jump === b.jump &&
    a.sizeK === b.sizeK &&
    a.osName === b.osName &&
    a.ringSince === b.ringSince &&
    x.address === y.address &&
    x.attempt === y.attempt &&
    x.reason === y.reason &&
    x.since === y.since
  )
}

/* ---------------- 记忆化（模块级纯缓存：只按内容记忆化，不参与渲染历史，故无需 ref） ---------------- */

/** 布局缓存：键 = 链结构签名 + 尺寸 —— 同键必得同一份布局（值只读，跨渲染/跨挂载复用） */
const layoutMemo = new Map<string, ReturnType<typeof layoutTopology>>()
const LAYOUT_MEMO_MAX = 32

function layoutCached(
  sig: string,
  chains: string[][],
  spacing: number,
  nodeSize: number
): ReturnType<typeof layoutTopology> {
  const key = `${sig}|${spacing}|${nodeSize}`
  const hit = layoutMemo.get(key)
  if (hit) return hit
  const placed = layoutTopology(chains, spacing, nodeSize)
  if (layoutMemo.size >= LAYOUT_MEMO_MAX) layoutMemo.clear()
  layoutMemo.set(key, placed)
  return placed
}

/**
 * 节点/边对象记忆化：内容相同即返回同一身份，让 React Flow 与 memo 后的组件跳过重渲染。
 * 缓存按本轮在用的 id 裁剪（图规模远小于主机总数，不会无界增长）；
 * 复用只发生在内容完全一致时，所以跨画布共享同一对象是安全的（消费方只读，合并 measured 时会另建副本）。
 */
const nodeMemo = new Map<string, Node<TopoNodeData>>()
const edgeMemo = new Map<string, Edge<TopoEdgeData>>()

function internNodes(next: Node<TopoNodeData>[]): Node<TopoNodeData>[] {
  const live = new Set(next.map((n) => n.id))
  for (const id of nodeMemo.keys()) if (!live.has(id)) nodeMemo.delete(id)
  return next.map((n) => {
    const prev = nodeMemo.get(n.id)
    const node =
      prev &&
      prev.type === n.type &&
      samePos(prev.position, n.position) &&
      sameNodeData(prev.data, n.data)
        ? prev
        : n
    nodeMemo.set(n.id, node)
    return node
  })
}

function internEdges(next: Edge<TopoEdgeData>[]): Edge<TopoEdgeData>[] {
  const live = new Set(next.map((e) => e.id))
  for (const id of edgeMemo.keys()) if (!live.has(id)) edgeMemo.delete(id)
  return next.map((e) => {
    const prev = edgeMemo.get(e.id)
    const edge =
      prev &&
      prev.source === e.source &&
      prev.target === e.target &&
      prev.data?.state === e.data?.state &&
      prev.data?.leaving === e.data?.leaving
        ? prev
        : e
    edgeMemo.set(e.id, edge)
    return edge
  })
}

/** 目标主机的链（去重连续跳板 + 自身）；无链路记录时退化为单节点。
 *  跳板链取链路快照的事实值（实际建立的链，拨号中为正在拨的链）——
 *  图画的是实际网络拓扑，配置理论值不上图。 */
function chainOf(conn: HostConnection | undefined, hostId: string, jumpIds?: string[]): string[] {
  if (!conn) return [hostId]
  const hops = [...(jumpIds ?? conn.jumpHostIds ?? []), conn.id]
  const out: string[] = []
  for (const h of hops) if (h && out[out.length - 1] !== h) out.push(h)
  return out
}

/** 链路相位 → 展示态（唯一映射表） */
function linkStateOf(phase: LinkPhase): DisplayState {
  switch (phase) {
    case 'connected':
      return 'healthy'
    case 'connecting':
      return 'dialing'
    case 'reconnecting':
      return 'retrying'
    case 'offline':
      return 'failed'
    case 'idle':
      return 'closed'
  }
}

/**
 * 边视觉态：目标展示态 + 活动（已连接且操作中 → 数据包动效；操作在等人工审批 → 琥珀数据包）。
 * 展示态优先：链路一旦不在 healthy（建连中/断开/失败），审批态不再作为边的视觉，
 * 但节点光环仍由节点自己的 active/pending 决定 —— 审批未决与链路掉线可以同时成立。
 */
function edgeStateOf(display: DisplayState, active: boolean, pending: boolean): EdgeState {
  if (active && display === 'healthy') return pending ? 'pending' : 'working'
  return display
}

export function useTopologyGraph(
  spacing: number,
  nodeSize: number
): {
  nodes: Node<TopoNodeData>[]
  edges: Edge<TopoEdgeData>[]
} {
  /** OS 资产与地址（与连接行同源）；节点集合不来自这里，这里只供取图标/标签/跳板链 */
  const conns = useConnectionsStore((s) => s.connections)
  /** 只订阅 osNames：perf 采样每 3s 刷新所有已连接主机的 samples，而本图只用其中的 OS 名，
   *  且 osNames 已由 foldOsNames 折叠同一份样本 —— 订阅 samples 会让全图每 3s 重算一次 */
  const osNames = usePerfStore((s) => s.osNames)

  /** 链路相位来自全局镜像（stores/links）：连接列表状态列与拓扑图共用一份，主进程为唯一权威 */
  const links = useLinksStore((s) => s.byHost)
  const [activity, setActivity] = useState<Record<string, ActivityEntry>>({})
  const [fading, setFading] = useState<Record<string, FadeStage>>({})
  /** 已触发过系统名单次采集的 hostId（链路失活后允许重采） */
  const probedRef = useRef(new Set<string>())

  /* ---------- 轴①的副作用：重新建连/已连上 → 撤销退场（含已移除的节点重新入场） ---------- */
  useEffect(() => {
    const onState = (e: HostStateEvent): void => {
      if (e.phase !== 'offline' && e.phase !== 'idle') {
        setFading((prev) => (e.hostId in prev ? withoutKey(prev, e.hostId) : prev))
      }
    }
    const off = window.aterm.hosts.onState(onState)
    const offAgent = window.aterm.hosts.onAgentState(onState)
    return () => {
      off()
      offAgent()
    }
  }, [])

  /* ---------- 轴②：AI 活动（正交于链路；最短 3s + 淡出）
     审批叠加：gate 判成 user-approval 时 SDK 在 tool-input-available 之后紧跟
     tool-approval-request（isAutomatic 缺省），并就此结束本次回合（等用户作答）——
     所以等待态必须跨回合存活，回合收尾的清理要放过这些调用（见 turn-end 分支）。
     渲染层写回响应后 sendAutomaticallyWhen 续跑，新回合以 start 流片开篇 ——
     据「回合重启 ⇒ 上一轮的待审批都已被应答」撤销琥珀态（tool-approval-response
     只在自动放行/自动拦截那条流里出现，人工审批续跑的流里没有这个流片）。 ---------- */
  useEffect(() => {
    /** 工具调用的全局标识（sessionId 是 UUID，不含分隔符） */
    const callKey = (sessionId: string, toolCallId: string): string =>
      `${sessionId}\u0000${toolCallId}`
    const ownsKey = (key: string, sessionId: string): boolean => key.startsWith(`${sessionId}\u0000`)
    const targets = new Map<string, string>() // callKey → 主机（'CENTER' 或 hostId）
    const entries = new Map<string, ActivityEntry>()
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    /** 等人工审批的调用（callKey）：连线与光环转琥珀 */
    const awaiting = new Set<string>()
    /** approvalId → callKey：tool-approval-response 只带 approvalId，需回查是哪个调用 */
    const approvals = new Map<string, string>()
    const publish = (): void => setActivity(Object.fromEntries(entries))
    const clearTimer = (key: string): void => {
      clearTimeout(timers.get(key))
      timers.delete(key)
    }
    const settle = (key: string): void => {
      const entry = entries.get(key)
      if (!entry || entry.count > 0) return
      entries.set(key, { ...entry, settling: true })
      publish()
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key)
          entries.delete(key)
          publish()
        }, PULSE_FADE_MS)
      )
    }
    const begin = (callId: string, key: string): void => {
      if (targets.has(callId)) return
      targets.set(callId, key)
      clearTimer(key)
      const entry = entries.get(key)
      entries.set(key, {
        count: (entry?.count ?? 0) + 1,
        // 审批请求可能先于 begin（execute 按 executionId 异步反查主机）：这里补记待审批计数
        pending: (entry?.pending ?? 0) + (awaiting.has(callId) ? 1 : 0),
        since: entry?.count ? entry.since : performance.now(),
        settling: false
      })
      publish()
    }
    /** 标记调用在等人工审批（主机尚未反查出来时先只记调用，begin 时补记计数） */
    const markWaiting = (callId: string): void => {
      if (awaiting.has(callId)) return
      awaiting.add(callId)
      const key = targets.get(callId)
      const entry = key ? entries.get(key) : undefined
      if (!key || !entry) return
      entries.set(key, { ...entry, pending: entry.pending + 1 })
      publish()
    }
    /** 撤销待审批（人工已应答）：计数归零即连线回到蓝色操作态 */
    const clearWaiting = (callId: string): void => {
      if (!awaiting.delete(callId)) return
      const key = targets.get(callId)
      const entry = key ? entries.get(key) : undefined
      if (!key || !entry || entry.pending === 0) return
      entries.set(key, { ...entry, pending: entry.pending - 1 })
      publish()
    }
    /** 调用收尾（有结果 / 被拒绝 / 回合收尾）：计数归零后按最短展示时长转淡出 */
    const end = (callId: string): void => {
      const key = targets.get(callId)
      if (!key) return
      clearWaiting(callId)
      targets.delete(callId)
      const entry = entries.get(key)
      if (!entry) return
      const count = Math.max(0, entry.count - 1)
      entries.set(key, { ...entry, count })
      if (count > 0) return
      const wait = Math.max(0, entry.since + PULSE_MIN_MS - performance.now())
      clearTimer(key)
      timers.set(
        key,
        setTimeout(() => settle(key), wait)
      )
    }
    const off = window.aterm.ai.onEvent((e) => {
      /* 回合收尾 = 本轮工具调用都已有定论（有结果 / 被取消）。注意「等人工审批」的调用不在其列：
         审批请求会直接结束本次回合（等用户作答），它的活动必须跨回合活到用户应答之后。
         其余没收到的结果的调用（自动拦截、生成中途取消）在此收尾，否则光环与流光会一直亮着 */
      if (e.type === 'turn-end') {
        for (const callId of [...targets.keys()])
          if (ownsKey(callId, e.sessionId) && !awaiting.has(callId)) end(callId)
        return
      }
      if (e.type !== 'chunk') return
      const c = e.chunk
      const callId = 'toolCallId' in c ? callKey(e.sessionId, c.toolCallId) : ''
      if (c.type === 'tool-input-available') {
        const input = c.input as { hostId?: string; executionId?: string } | undefined
        if (input?.hostId) return begin(callId, input.hostId)
        // execute 按 executionId 操作时主机在执行记录里，异步反查
        if (c.toolName === 'execute' && input?.executionId) {
          void window.aterm.executions
            .list(e.sessionId)
            .then((tasks) =>
              begin(
                callId,
                tasks.find((t) => t.executionId === input.executionId)?.hostId ?? 'CENTER'
              )
            )
            .catch(() => begin(callId, 'CENTER'))
          return
        }
        return begin(callId, 'CENTER')
      }
      // 人工审批未决：连线/光环转琥珀。自动放行/自动拦截不打扰用户，不进等待态
      // （两种通道都记 approvalId → 调用，随后的应答流片据此收尾）
      if (c.type === 'tool-approval-request') {
        approvals.set(c.approvalId, callId)
        if (!c.isAutomatic) markWaiting(callId)
        return
      }
      // 自动通道的即时应答：被拒的调用不会再有结果，直接收尾（放行的等 tool-output-*）
      if (c.type === 'tool-approval-response') {
        const call = approvals.get(c.approvalId)
        if (!call) return
        approvals.delete(c.approvalId)
        clearWaiting(call)
        if (!c.approved) end(call)
        return
      }
      // 回合重启（人工审批写回后自动续跑）：上一轮的待审批都已被应答，撤销琥珀态
      if (c.type === 'start') {
        for (const call of [...awaiting]) if (ownsKey(call, e.sessionId)) clearWaiting(call)
        for (const [approvalId, call] of [...approvals])
          if (ownsKey(call, e.sessionId)) approvals.delete(approvalId)
        return
      }
      if (
        c.type !== 'tool-output-available' &&
        c.type !== 'tool-output-error' &&
        c.type !== 'tool-output-denied'
      )
        return
      end(callId)
    })
    return () => {
      off()
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  /* ---------- 退场调度：断开/失败保留 5 分钟 → 淡出 → 移除 ----------
     只在定时器回调里写状态（不在 effect 体内 setState）；相位回退的撤销由轴①事件处理 */
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const now = Date.now()
    const later = (fn: () => void, ms: number): void => {
      const t = setTimeout(() => {
        timers.delete(t)
        fn()
      }, ms)
      timers.add(t)
    }
    /** 出场：淡出（out）→ 移除（gone）。
     *  环在调度时已走完（挂载前就断开 / 本 effect 因别处链路变化重跑）则直接判出场，不播淡出 */
    const startOut = (id: string, animate: boolean): void => {
      // 触发时二次确认相位：期间已重连则放弃本次退场（从全局镜像现取，避免陈旧闭包）
      const live = useLinksStore.getState().byHost[id]
      if (!live || (live.phase !== 'offline' && live.phase !== 'idle')) return
      // 已在退场 / 已出场者沿用原进度：出场是一次性的，重播会让早就消失的节点又闪出来一下
      setFading((prev) => (prev[id] ? prev : { ...prev, [id]: animate ? 'out' : 'gone' }))
      // 定时器照排（本 effect 重跑会清掉上一轮的定时器）：把淡出接续到 gone；已 gone / 已重连则为空操作
      later(
        () => setFading((prev) => (prev[id] === 'out' ? { ...prev, [id]: 'gone' } : prev)),
        LEAVE_FADE_MS
      )
    }
    for (const [id, link] of Object.entries(links)) {
      if (link.phase !== 'offline' && link.phase !== 'idle') continue
      const remain = link.since + OFFLINE_RING_MS - now
      later(() => startOut(id, remain > 0), Math.max(0, remain))
    }
    return () => {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    }
  }, [links])

  /* ---------- OS 图标：无缓存时按需单次采集 ---------- */
  useEffect(() => {
    const missing = conns
      .map((c) => c.id)
      .filter(
        (id) => links[id]?.phase === 'connected' && !osNames[id] && !probedRef.current.has(id)
      )
    for (const id of probedRef.current) {
      if (links[id]?.phase !== 'connected') probedRef.current.delete(id)
    }
    if (missing.length > 0) {
      for (const id of missing) probedRef.current.add(id)
      window.aterm.perf.probeOs(missing)
    }
  }, [conns, links, osNames])

  /* ---------- 投影：上图主机 → 链 → 布局 → nodes/edges ---------- */
  const { nodes, edges } = useMemo(() => {
    // 上图主机 = links 键集里尚未退场者（发生过连接动作）；跳板中间节点由链一并带出
    const chains = Object.keys(links)
      .filter((id) => fading[id] !== 'gone')
      .map((id) =>
        chainOf(
          conns.find((c) => c.id === id),
          id,
          links[id]?.jumpIds
        )
      )
    // 叶子集合（链的终点 = 真正被连接的主机）；其余上图的都是跳板中间节点
    const leaves = new Set(chains.map((c) => c[c.length - 1]))

    // 每条链的目标展示态（活动叠加不改变展示态，只额外标记 active）
    const targetState = new Map<string, DisplayState>()
    for (const chain of chains) {
      const leaf = chain[chain.length - 1]
      const link = links[leaf]
      if (link) targetState.set(leaf, linkStateOf(link.phase))
    }

    // 节点展示态聚合：共享跳板取经过它的全部链中「最优」态
    const nodeState = new Map<string, DisplayState>()
    for (const chain of chains) {
      const s = targetState.get(chain[chain.length - 1])
      if (!s) continue
      for (const hostId of chain) {
        const cur = nodeState.get(hostId)
        if (!cur || STATE_RANK[s] < STATE_RANK[cur]) nodeState.set(hostId, s)
      }
    }

    // 布局只依赖「链结构 + 尺寸」：签名未变即命中记忆化缓存（链路状态/活动变化不重跑布局算法）
    const sig = chains
      .map((c) => c.join('>'))
      .sort()
      .join('|')
    const placed = layoutCached(sig, chains, spacing, nodeSize)

    const detailOf = (
      link: HostLinkSnapshot | undefined,
      conn: HostConnection | undefined
    ): NodeDetail => {
      const detail: NodeDetail = {}
      if (conn) detail.address = `${conn.username}@${conn.host}:${conn.port}`
      // 仅异常/进行中态才需要解释
      if (link && (link.phase === 'reconnecting' || link.phase === 'offline')) {
        if (link.attempt) detail.attempt = link.attempt
        if (link.reason) detail.reason = link.reason
      }
      if (link && (link.phase === 'offline' || link.phase === 'idle')) detail.since = link.since
      return detail
    }

    const nodes: Node<TopoNodeData>[] = [
      {
        id: 'CENTER',
        type: 'center',
        position: { x: 0, y: 0 },
        draggable: false,
        selectable: false,
        data: {
          label: '',
          state: 'healthy',
          active: 'CENTER' in activity,
          pending: (activity.CENTER?.pending ?? 0) > 0,
          settling: activity.CENTER?.settling ?? false,
          leaving: false,
          jump: false,
          sizeK: nodeSize,
          osName: '',
          detail: {}
        }
      }
    ]
    for (const [hostId, pos] of placed) {
      const link = links[hostId]
      const conn = conns.find((c) => c.id === hostId)
      const state = nodeState.get(hostId) ?? 'closed'
      const act = activity[hostId]
      const ringSince = (state === 'failed' || state === 'closed') && link ? link.since : undefined
      nodes.push({
        id: hostId,
        type: 'host',
        position: pos,
        data: {
          hostId,
          label: conn?.name || conn?.host || hostId.slice(0, 8),
          state,
          // 计数归零后条目仍留到淡出结束（最短展示时长 + PULSE_FADE_MS）：期间保持「有活动」
          active: !!act,
          pending: !!act && act.pending > 0,
          settling: act?.settling ?? false,
          leaving: fading[hostId] === 'out',
          jump: !leaves.has(hostId),
          sizeK: nodeSize,
          osName: osNames[hostId] || '',
          detail: detailOf(link, conn),
          ringSince
        }
      })
    }

    // 边：中心 → 链上逐跳；同一段边被多条链共享时取最优展示态
    const edgeByKey = new Map<string, { display: DisplayState; state: EdgeState }>()
    for (const chain of chains) {
      const leaf = chain[chain.length - 1]
      const display = targetState.get(leaf)
      if (!display) continue
      const act = activity[leaf]
      const pending = !!act && act.pending > 0
      const state = edgeStateOf(display, !!act && !act.settling, pending)
      for (const [k, hostId] of chain.entries()) {
        const source = k === 0 ? 'CENTER' : chain[k - 1]
        const key = `${source}>${hostId}`
        const cur = edgeByKey.get(key)
        // 按展示态排序去重（叠加态不参与展示态排序，故比较 display 而非 state），
        // 展示态相同则取叠加态高者：等审批 > 操作中 > 无活动
        if (
          !cur ||
          STATE_RANK[display] < STATE_RANK[cur.display] ||
          (display === cur.display && EDGE_ACT_RANK[state] > EDGE_ACT_RANK[cur.state])
        ) {
          edgeByKey.set(key, { display, state })
        }
      }
    }
    const edges: Edge<TopoEdgeData>[] = [...edgeByKey].map(([key, v]) => {
      const [source, target] = key.split('>')
      return {
        id: key,
        source,
        target,
        type: 'topo',
        data: { state: v.state, leaving: fading[target] === 'out' }
      }
    })

    // 内容未变的节点/边沿用同一对象身份：React Flow 与 memo 后的组件据此跳过重渲染
    return { nodes: internNodes(nodes), edges: internEdges(edges) }
  }, [conns, links, activity, fading, nodeSize, spacing, osNames])

  return { nodes, edges }
}
