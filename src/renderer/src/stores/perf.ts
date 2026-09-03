import { create } from 'zustand'
import type { PerfGpuSample, PerfSample } from '@shared/types'

/**
 * 主机性能样本镜像（连接列表页性能列）+ 主机系统名本地缓存（OS 图标启动即显）：
 * 打开页面拉快照，此后吃 perf:sample 事件增量；主进程 3s 轮询已连接主机。
 * osNames：hostId → osName，localStorage 持久化，store 创建时同步水合（零闪烁）；
 * 更新来源两条：性能采样（apply）与会话链路建立后的兜底采集（applyOs，os:sample 事件），
 * 非空且有变化才回写；UI 取值"实时样本优先、缓存兜底、无缓存默认图标"。
 */

const OS_CACHE_KEY = 'ggterm.osNames'

function loadOsCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(OS_CACHE_KEY)
    const value: unknown = raw === null ? undefined : JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, name]) => typeof name === 'string'))
  } catch {
    return {}
  }
}

function saveOsCache(names: Record<string, string>): void {
  try {
    localStorage.setItem(OS_CACHE_KEY, JSON.stringify(names))
  } catch {
    // 缓存不可写（配额/权限）不应打断实时性能样本更新。
  }
}

/** 对比回写：非空 osName 且有变化才更新并持久化；空值（远端无 os-release）不覆盖缓存 */
function foldOsNames(
  cur: Record<string, string>,
  events: { hostId: string; osName: string }[]
): Record<string, string> {
  let next: Record<string, string> | null = null
  for (const e of events) {
    if (e.osName === '' || (next ?? cur)[e.hostId] === e.osName) continue
    if (!next) next = { ...cur }
    next[e.hostId] = e.osName
  }
  if (next) saveOsCache(next)
  return next ?? cur
}

/** 折线图滚动历史上限（@3s 约 6 分钟，≥ 5 分钟窗口留缓冲） */
export const PERF_HIST_MAX = 120

export interface PerfHistory {
  cpu: { t: number; v: number }[]
  net: { t: number; rx: number; tx: number }[]
}

/** 追加一帧样本到滚动历史（CPU 折线 + 网络上下行折线），超出上限丢最旧；
 *  列表 hub 链路不采网速（netRx/netTx 为 null），此时不追加网络点（避免把折线拉成 0 平线） */
function appendHistory(
  cur: Record<string, PerfHistory>,
  e: PerfSample
): Record<string, PerfHistory> {
  const prev = cur[e.hostId] ?? { cpu: [], net: [] }
  const cpu =
    e.cpuPct !== null && e.cpuPct !== undefined
      ? [...prev.cpu, { t: e.t, v: e.cpuPct }].slice(-PERF_HIST_MAX)
      : prev.cpu
  const net =
    e.netRx !== null || e.netTx !== null
      ? [...prev.net, { t: e.t, rx: e.netRx ?? 0, tx: e.netTx ?? 0 }].slice(-PERF_HIST_MAX)
      : prev.net
  return { ...cur, [e.hostId]: { cpu, net } }
}

interface PerfState {
  samples: Record<string, PerfSample>
  /** 主机系统名缓存（跨启动；启动时同步水合） */
  osNames: Record<string, string>
  /** GPU 专用低频样本（会话面板；与 3s 全量 samples 分开存，两条流互不覆盖） */
  gpuSamples: Record<string, PerfGpuSample>
  /** 折线图滚动历史（会话性能面板消费；跨面板切换持久） */
  histories: Record<string, PerfHistory>
  /** 页面挂载时拉快照 */
  loadSnapshot: () => Promise<void>
  apply: (e: PerfSample) => void
  /** GPU 低频样本回流（'perf:gpu'）：只保留最近一帧（面板只看当前值，不留历史） */
  applyGpu: (e: PerfGpuSample) => void
  /** 会话链路建立后的兜底采集回包（通道与 perf:sample 不同，落点同为 osNames） */
  applyOs: (e: { hostId: string; osName: string }) => void
  /** 连接删除后清理孤儿缓存项（以全量连接列表为基准） */
  prune: (validIds: string[]) => void
}

export const usePerfStore = create<PerfState>((set, get) => ({
  samples: {},
  osNames: loadOsCache(),
  gpuSamples: {},
  histories: {},

  loadSnapshot: async () => {
    const samples = await window.aterm.perf.snapshot()
    // 快照同样折叠 osName（页面重挂/热重载后缓存不至于落后于主进程最近样本）
    const osNames = foldOsNames(get().osNames, Object.values(samples))
    set(osNames === get().osNames ? { samples } : { samples, osNames })
  },

  apply: (e) => {
    const samples = { ...get().samples, [e.hostId]: e }
    const osNames = foldOsNames(get().osNames, [e])
    const histories = appendHistory(get().histories, e)
    set(osNames === get().osNames ? { samples, histories } : { samples, histories, osNames })
  },

  /** GPU 低频样本：只保留最近一帧（面板只看当前值，不做历史曲线） */
  applyGpu: (e) => {
    set({ gpuSamples: { ...get().gpuSamples, [e.hostId]: e } })
  },

  applyOs: (e) => {
    const osNames = foldOsNames(get().osNames, [e])
    if (osNames !== get().osNames) set({ osNames })
  },

  prune: (validIds) => {
    const valid = new Set(validIds)
    const retain = <T>(entries: Record<string, T>): Record<string, T> => {
      const kept = Object.entries(entries).filter(([id]) => valid.has(id))
      return kept.length === Object.keys(entries).length ? entries : Object.fromEntries(kept)
    }
    const current = get()
    const osNames = retain(current.osNames)
    const samples = retain(current.samples)
    const gpuSamples = retain(current.gpuSamples)
    const histories = retain(current.histories)
    if (osNames !== current.osNames) saveOsCache(osNames)
    if (
      osNames !== current.osNames ||
      samples !== current.samples ||
      gpuSamples !== current.gpuSamples ||
      histories !== current.histories
    )
      set({ osNames, samples, gpuSamples, histories })
  }
}))
