import { isNetworkDevice } from '../../shared/device'
import { listConnections } from '../data/connections'
import { BrowserWindow } from 'electron'
import type { PerfGpu, PerfGpuProc, PerfGpuSample } from '../../shared/types'
import { appLog } from '../log'
import { getLink } from './link'
import { parseGpuAppRow, parseGpuRow } from './perf'
import { GPU_SCRIPT } from './remoteScripts'
import { execCommand } from './sftp'

/**
 * 会话面板的 GPU 专用采样（与 sessionPerf 的 3s 全量采样分开两条路）：
 * - 由活动栏性能面板开/关驱动（sessionPerfWatch → sessionGpuWatch），借用会话共享连接 exec，
 *   零额外连接；面板一关（watch(null)）就停，不留后台探测
 * - 间隔 15s：利用率/显存/温度都是慢变量，3s 粒度没有意义 —— 单独成路后
 *   PERF_SCRIPT（3s 全量）不再 fork nvidia-smi，GPU 主机开销降到原来的 1/5 以下
 * - 开面板立即首采（同一时刻只有一个会话面板，不需要像连接列表 hub 那样错峰）
 * - 样本走独立的 'perf:gpu' 事件：和 3s 全量样本节奏不同，混在一条流里会把
 *   「本轮没采 GPU」误读成「该主机没有 GPU」
 * - 远端没有 nvidia-smi 时输出为空 —— 属于正常结果（gpus: []，面板整段不渲染）；
 *   真正的 exec 失败只记一条日志，下一轮自动重试
 */

/** GPU 专用采样间隔（慢变量，不跟随 3s 全量采样） */
const GPU_INTERVAL_MS = 15_000
/** 每卡只保留显存占用前 N 个进程（面板展示用） */
const GPU_PROC_LIMIT = 5

let watched: string | null = null
let timer: NodeJS.Timeout | null = null
/** 上轮未归（远端卡顿）时跳过本轮，防堆积 */
let sampling = false
/** 同一段故障只记一条日志（成功后重置） */
let loggedFail = false

function broadcast(sample: PerfGpuSample): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('perf:gpu', sample)
}

/** 面板开 → watch(hostId)；面板关/切走/无共享连接 → watch(null) */
export function sessionGpuWatch(hostId: string | null): void {
  if (watched === hostId) return
  if (timer) clearInterval(timer)
  timer = null
  watched = hostId
  if (!hostId || !getLink(hostId)) return
  void sample(hostId)
  timer = setInterval(() => void sample(hostId), GPU_INTERVAL_MS)
}

async function sample(hostId: string): Promise<void> {
  if (isNetworkDevice(listConnections().find((c) => c.id === hostId))) {
    sessionGpuWatch(null)
    return
  }
  if (sampling || watched !== hostId) return
  const client = getLink(hostId)?.activeClient
  if (!client) return
  sampling = true
  try {
    const out = await execCommand(client, GPU_SCRIPT)
    const lines = out.split('\n')
    // 计算进程行（A）按 uuid 归并到对应卡：每卡只留显存占用前 GPU_PROC_LIMIT 个
    const procsByUuid = new Map<string, PerfGpuProc[]>()
    for (const l of lines.filter((l) => l.startsWith('A '))) {
      const row = parseGpuAppRow(l)
      if (!row) continue
      const list = procsByUuid.get(row.uuid)
      if (list) list.push(row.proc)
      else procsByUuid.set(row.uuid, [row.proc])
    }
    const gpus = lines
      .filter((l) => l.startsWith('G '))
      .map(parseGpuRow)
      .filter((g): g is PerfGpu => g !== null)
      .map((g) => ({
        ...g,
        procs: (procsByUuid.get(g.uuid) ?? [])
          .sort((a, b) => b.mem - a.mem)
          .slice(0, GPU_PROC_LIMIT)
      }))
    loggedFail = false
    if (watched === hostId) broadcast({ hostId, gpus, t: Date.now() })
  } catch (err) {
    if (!loggedFail) {
      loggedFail = true
      const label = getLink(hostId)?.connection.name ?? hostId
      appLog('ssh', `GPU sampling failed "${label}": ${(err as Error).message}`, 'error')
    }
  } finally {
    sampling = false
  }
}
