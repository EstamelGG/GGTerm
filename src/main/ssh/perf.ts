import type { Client } from 'ssh2'
import type { PerfDisk, PerfDiskMount, PerfGpu, PerfGpuProc, PerfSample } from '../../shared/types'
import { appLog } from '../log'
import { execCommand } from './sftp'
import { PERF_SCRIPT } from './remoteScripts'

/**
 * 主机性能采集（由 perfHub / sessionPerf 驱动，client 来源动态选择，与终端会话生命周期解耦）：
 * - 按实例间隔 exec 远端脚本（remoteScripts.PERF_SCRIPT），一次往返拿全部指标
 *   （列表 hub 低频 10s + 不采网速；会话面板 3s 全量）
 * - 输出归一化 "P ..."（脚本内 sleep 1 双读 → CPU 首轮即有值），只认这一行
 * - 熔断：连接失败 + 脚本/解析失败合并计数，连续 BREAK_THRESHOLD 次暂停自动刷新，
 *   点击列表头刷新按钮（refreshNow）清零重试，成功即恢复周期；认证失败不经此计数
 *   （hub 层停等，仅编辑保存/重启恢复）
 * - start() 错峰首采：条目多为"视口重新可见"而建，随机延迟 0~1 个周期再首采
 *   （快速滚过的行不会打远端，自然去抖；批量建条目时样本逐台错开到达）；
 *   手动刷新走 refreshNow 立即采样
 */

/** 会话面板采样间隔（面板打开期间 3s 全量指标，跑在会话连接上，无额外连接） */
export const SESSION_INTERVAL_MS = 3_000
/** 列表 hub 采样间隔（低频概览 + 跳过网速解析，降低空闲主机探测开销） */
export const HUB_INTERVAL_MS = 10_000
/** 连续失败熔断阈值（≈60s @3s / ≈200s @10s） */
const BREAK_THRESHOLD = 20

export class PerfMonitor {
  private timer: NodeJS.Timeout | null = null
  /** 首采错峰定时器：批量建条目时随机延迟，避免整列同相位出数 */
  private startTimer: NodeJS.Timeout | null = null
  private sampling = false
  /** 上轮网络字节总量与时刻（速率差值分母） */
  private lastNet: { rx: number; tx: number; at: number } | null = null
  /** 上轮每逻辑核原始 jiffies（占用差值基准） */
  private lastPerCore: { total: number; idle: number }[] | null = null
  /** 上轮各物理盘原始扇区计数（读写速度差值基准） */
  private lastDisk: Record<string, { read: number; write: number }> | null = null
  /** 最近一次成功样本（perf:snapshot 快照用） */
  last: PerfSample | null = null

  /** 诊断日志只记首次（成功/失败各一条，防刷屏） */
  private loggedStart = false
  private loggedFail = false
  /** 熔断计数与状态 */
  private failCount = 0
  private broken = false

  constructor(
    private readonly hostId: string,
    private readonly getClient: () => Client | null | Promise<Client | null>,
    private readonly onSample: (s: PerfSample) => void,
    /** 展示名（日志用） */
    private readonly label = '',
    /** intervalMs：采样间隔（缺省 SESSION_INTERVAL_MS）；collectNet：是否计算网速（缺省是，列表 hub 关闭） */
    private readonly opts: { intervalMs?: number; collectNet?: boolean } = {}
  ) {}

  private get intervalMs(): number {
    return this.opts.intervalMs ?? SESSION_INTERVAL_MS
  }

  private get collectNet(): boolean {
    return this.opts.collectNet ?? true
  }

  start(): void {
    if (this.timer || this.startTimer) return
    this.loggedStart = false
    this.loggedFail = false
    this.failCount = 0
    this.broken = false
    // 错峰首采：批量建条目（可见集整体同步）时随机延迟 0~1 个周期再首采，
    // 之后各条目保持自己的相位 —— 样本逐台错开到达，不做整列同跳
    this.startTimer = setTimeout(
      () => {
        this.startTimer = null
        void this.sample()
        this.ensureTimer()
      },
      Math.round(Math.random() * this.intervalMs)
    )
  }

  /** 手动刷新：清熔断 + 立即采样 + 恢复自动周期（成功即续跑，失败重新计数）；取消未触发的错峰定时 */
  refreshNow(): void {
    this.failCount = 0
    this.broken = false
    if (this.startTimer) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
    void this.sample()
    this.ensureTimer()
  }

  /** 清计时器 + 重置速率基准（恢复/重启后首轮重新积累）；最近样本（last）保留供快照/UI */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
    this.timer = null
    this.lastNet = null
    this.lastPerCore = null
    this.lastDisk = null
  }

  /** 性能列隐藏（窄窗口）暂停：只清计时器，熔断计数与最近样本全保留（UI 已显示数据不变） */
  pause(): void {
    this.stop()
  }

  /** 性能列恢复可见：按原间隔续跑；已熔断的不自动恢复（等待手动刷新） */
  resume(): void {
    if (this.timer || this.broken) return
    this.ensureTimer()
  }

  /** 启动周期采样（幂等）：start / resume / refreshNow 统一入口 */
  private ensureTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.sample(), this.intervalMs)
  }

  /** hub 连接失败记账（与脚本执行/解析失败共用熔断计数） */
  noteFailure(): void {
    this.registerFailure()
  }

  private registerFailure(): void {
    if (this.broken) return
    this.failCount += 1
    if (this.failCount >= BREAK_THRESHOLD) {
      this.broken = true
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      appLog(
        'ssh',
        `Perf probe circuit tripped "${this.label}" (${BREAK_THRESHOLD} consecutive failures, auto refresh paused; click the refresh button in the column header to retry)`,
        'warning'
      )
    }
  }

  private registerSuccess(): void {
    this.failCount = 0
    this.broken = false
  }

  private async sample(): Promise<void> {
    if (this.broken) return
    const client = await this.getClient()
    if (!client || this.sampling) return
    this.sampling = true // 上轮未归（>3s 网络延迟）时跳过，防堆积
    try {
      const out = await execCommand(client, PERF_SCRIPT)
      const sample = this.parse(out)
      if (sample) {
        this.registerSuccess()
        this.last = sample
        this.onSample(sample)
        if (!this.loggedStart) {
          this.loggedStart = true
          appLog(
            'ssh',
            `Perf sampling started "${this.label}" (${this.intervalMs / 1000}s interval)`
          )
        }
      } else {
        this.registerFailure()
        if (!this.loggedFail) {
          this.loggedFail = true
          appLog(
            'ssh',
            `Perf sampling failed "${this.label}": unparseable output (remote may not be Linux): ${out.split('\n')[0] ?? ''}`,
            'error'
          )
        }
      }
    } catch (err) {
      this.registerFailure()
      if (!this.loggedFail) {
        this.loggedFail = true
        appLog('ssh', `Perf sampling failed "${this.label}": ${(err as Error).message}`, 'error')
      }
    } finally {
      this.sampling = false
    }
  }

  /** 解析脚本归一化输出（按行首前缀：P/M/C/T/L/F/R/O） */
  private parse(out: string): PerfSample | null {
    const lines = out.split('\n').map((l) => l.trim())
    const pLine = lines.find((l) => l.startsWith('P '))
    const oLine = lines.find((l) => l.startsWith('O '))
    if (!pLine) return null
    const f = pLine.split(/\s+/)
    if (f.length < 20) return null
    const [
      cpuTotal1,
      cpuIdle1,
      cpuTotal2,
      cpuIdle2,
      memTotalKb,
      memAvailKb,
      dfBlocks,
      dfUsed,
      cores,
      swapTotalKb,
      swapUsedKb,
      netRxBytes,
      netTxBytes,
      load1,
      load5,
      load15,
      procsRun,
      procsTotal,
      uptimeSec
    ] = f.slice(1).map(Number)
    if (
      !Number.isFinite(cpuTotal2) ||
      cpuTotal2 <= 0 ||
      !Number.isFinite(memTotalKb) ||
      memTotalKb <= 0 ||
      !Number.isFinite(memAvailKb) ||
      memAvailKb < 0 ||
      !Number.isFinite(dfBlocks) ||
      dfBlocks <= 0 ||
      !Number.isFinite(dfUsed) ||
      dfUsed < 0 ||
      !Number.isFinite(netRxBytes) ||
      netRxBytes < 0 ||
      !Number.isFinite(netTxBytes) ||
      netTxBytes < 0
    ) {
      return null
    }

    // CPU：脚本内 sleep 1 双读的 1s 窗口差值（首轮即有值；双读失败 → null）
    const cpuPct =
      cpuTotal2 > cpuTotal1 && Number.isFinite(cpuTotal1) && Number.isFinite(cpuIdle1)
        ? Math.min(100, Math.max(0, (1 - (cpuIdle2 - cpuIdle1) / (cpuTotal2 - cpuTotal1)) * 100))
        : null

    const now = Date.now()
    const dt = this.lastNet ? (now - this.lastNet.at) / 1000 : 0

    // 网络：字节总量差值 → B/s（首轮无基准 → null；计数器回绕/重启动会出现负值 → 0）；
    // collectNet=false（列表 hub）直接保持 null，不积累基准
    let netRx: number | null = null
    let netTx: number | null = null
    if (this.collectNet) {
      if (this.lastNet && dt > 0.5) {
        netRx = Math.max(0, Math.round((netRxBytes - this.lastNet.rx) / dt))
        netTx = Math.max(0, Math.round((netTxBytes - this.lastNet.tx) / dt))
      }
      this.lastNet = { rx: netRxBytes, tx: netTxBytes, at: now }
    }

    // 内存细分（M 行）：空闲 MemFree / 缓存 Buffers+Cached+SReclaimable
    const mLine = lines.find((l) => l.startsWith('M '))
    const mf = mLine ? mLine.split(/\s+/).slice(1).map(Number) : []
    const memFree = Math.max(0, mf[0] ?? 0) * 1024
    const memCache = Math.max(0, (mf[1] ?? 0) + (mf[2] ?? 0) + (mf[3] ?? 0)) * 1024

    // 时区（T 行）
    const tLine = lines.find((l) => l.startsWith('T '))
    const timezone = tLine ? tLine.slice(2).trim() : ''

    // 每逻辑核占用（C 行原始 jiffies 跨轮差值；首轮无基准 → 空数组）
    const cLine = lines.find((l) => l.startsWith('C '))
    const rawPerCore = cLine ? parseCoreRow(cLine) : []
    const prevCore = this.lastPerCore
    let perCore: number[] = []
    if (prevCore && dt > 0.5 && rawPerCore.length === prevCore.length) {
      perCore = rawPerCore.map((c, i) => {
        const dTotal = c.total - prevCore[i].total
        const dIdle = c.idle - prevCore[i].idle
        if (dTotal <= 0) return 0
        return Math.round(clampPct((1 - dIdle / dTotal) * 100) * 10) / 10
      })
    }
    this.lastPerCore = rawPerCore.length ? rawPerCore : null

    // 磁盘树 + 挂载点 + 读写速度（L/F/R 行）
    const lsblkNodes = lines
      .filter((l) => l.startsWith('L '))
      .map(parseLsblkNode)
      .filter((n): n is NonNullable<ReturnType<typeof parseLsblkNode>> => n !== null)
    const dfRows = lines
      .filter((l) => l.startsWith('F '))
      .map(parseDfRow)
      .filter((r): r is NonNullable<ReturnType<typeof parseDfRow>> => r !== null)
    const sectors: Record<string, { read: number; write: number }> = {}
    for (const l of lines.filter((l) => l.startsWith('R '))) {
      const r = parseSectorRow(l)
      if (r) sectors[r.name] = { read: r.read, write: r.write }
    }
    const disks = buildDisks(lsblkNodes, dfRows, sectors, this.lastDisk, dt)
    this.lastDisk = Object.keys(sectors).length ? sectors : null

    // 内存占用用"真占用"口径（与会话面板饼图一致）：Total − Free − (Buffers+Cached+SReclaimable)；
    // M 行缺失（细分不可得）时回退 MemAvailable 口径
    const memPct = mLine
      ? clampPct(((memTotalKb - (memFree + memCache) / 1024) / memTotalKb) * 100)
      : clampPct(((memTotalKb - memAvailKb) / memTotalKb) * 100)
    const diskPct = clampPct((dfUsed / dfBlocks) * 100)
    const swapPct =
      Number.isFinite(swapTotalKb) && swapTotalKb > 0 && Number.isFinite(swapUsedKb)
        ? clampPct((swapUsedKb / swapTotalKb) * 100)
        : null

    return {
      hostId: this.hostId,
      cores: Number.isFinite(cores) ? Math.max(1, Math.round(cores)) : 1,
      cpuPct: cpuPct === null ? null : Math.round(cpuPct * 10) / 10,
      memTotal: memTotalKb * 1024,
      memPct: Math.round(memPct * 10) / 10,
      diskTotal: dfBlocks * 1024,
      diskPct: Math.round(diskPct * 10) / 10,
      swapTotal: Math.max(0, swapTotalKb) * 1024,
      swapPct: swapPct === null ? null : Math.round(swapPct * 10) / 10,
      netRx,
      netTx,
      load1: Number.isFinite(load1) ? Math.round(load1 * 100) / 100 : null,
      load5: Number.isFinite(load5) ? Math.round(load5 * 100) / 100 : null,
      load15: Number.isFinite(load15) ? Math.round(load15 * 100) / 100 : null,
      procsRun: Number.isFinite(procsRun) && procsRun >= 0 ? Math.round(procsRun) : null,
      procsTotal: Number.isFinite(procsTotal) && procsTotal >= 0 ? Math.round(procsTotal) : null,
      uptimeSec: Number.isFinite(uptimeSec) && uptimeSec > 0 ? Math.round(uptimeSec) : null,
      osName: oLine ? oLine.slice(2) : '',
      timezone,
      memFree,
      memCache,
      perCore,
      disks,
      t: now
    }
  }
}

interface CoreCounter {
  total: number
  idle: number
}

interface SectorCounter {
  read: number
  write: number
}

interface LsblkNode {
  name: string
  type: string
  pkname: string
  size: number
  mount: string
}

interface DfRow {
  device: string
  fstype: string
  size: number
  used: number
  avail: number
  mount: string
}

/** 解析 "C n total0 idle0 total1 idle1 …" 每核原始 jiffies */
function parseCoreRow(s: string): CoreCounter[] {
  const f = s.split(/\s+/).slice(1).map(Number)
  const n = f[0]
  if (!Number.isFinite(n) || n <= 0) return []
  const out: CoreCounter[] = []
  for (let i = 0; i < n; i++) {
    const total = f[1 + i * 2]
    const idle = f[2 + i * 2]
    if (Number.isFinite(total) && Number.isFinite(idle)) out.push({ total, idle })
  }
  return out
}

/** 解析 lsblk -P 键值对行（NAME="vda" TYPE="disk" …） */
function parseLsblkPairs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /(\w+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out[m[1]] = m[2]
  return out
}

function parseLsblkNode(s: string): LsblkNode | null {
  const kv = parseLsblkPairs(s)
  const size = Number(kv.SIZE)
  if (!kv.NAME || !kv.TYPE || !Number.isFinite(size)) return null
  return { name: kv.NAME, type: kv.TYPE, pkname: kv.PKNAME || '', size, mount: kv.MOUNTPOINT || '' }
}

/** 解析 "F device fstype blocksKb usedKb availKb mount…" 挂载点行 */
function parseDfRow(s: string): DfRow | null {
  const parts = s.split(/\s+/).slice(1)
  if (parts.length < 6) return null
  const [device, fstype, blocksKb, usedKb, availKb] = parts
  const size = Number(blocksKb) * 1024
  const used = Number(usedKb) * 1024
  const avail = Number(availKb) * 1024
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(used) || !Number.isFinite(avail)) {
    return null
  }
  return {
    device: device.replace(/^\/dev\//, ''),
    fstype,
    size,
    used,
    avail,
    mount: parts.slice(5).join(' ')
  }
}

/** 解析 "R name readSectors writeSectors" 物理盘扇区行 */
function parseSectorRow(s: string): { name: string; read: number; write: number } | null {
  const parts = s.split(/\s+/).slice(1)
  if (parts.length < 3) return null
  const [name, read, write] = parts
  const r = Number(read)
  const w = Number(write)
  if (!name || !Number.isFinite(r) || !Number.isFinite(w)) return null
  return { name, read: r, write: w }
}

/** 解析 "G " 行（nvidia-smi --query-gpu --format=csv,noheader,nounits 原样透传）：
 *  index, uuid, utilization.gpu, memory.used, memory.total, temperature.gpu, power.draw,
 *  power.limit, fan.speed, driver_version, name（name 含空格，固定放最后一项）。
 *  非数值字段（[N/A]、空串）记 null；列数不足（查询失败或被 timeout 截断）整行丢弃。
 *  procs 由 "A" 行按 uuid 回填（gpuPerf.ts） */
export function parseGpuRow(s: string): PerfGpu | null {
  const f = s.slice(2).split(',')
  if (f.length < 11) return null
  const num = (v: string): number | null => {
    const raw = v.trim()
    if (raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  const pct = (v: number | null): number | null =>
    v === null ? null : Math.round(clampPct(v) * 10) / 10
  const index = num(f[0])
  if (index === null || index < 0) return null
  const mib = 1024 * 1024
  return {
    index: Math.round(index),
    uuid: f[1].trim(),
    utilPct: pct(num(f[2])),
    memUsed: Math.max(0, num(f[3]) ?? 0) * mib,
    memTotal: Math.max(0, num(f[4]) ?? 0) * mib,
    tempC: num(f[5]),
    powerW: num(f[6]),
    powerCapW: num(f[7]),
    fanPct: pct(num(f[8])),
    driver: f[9].trim(),
    name: f.slice(10).join(',').trim(),
    procs: []
  }
}

/** 解析 "A " 行（nvidia-smi --query-compute-apps：gpu_uuid, pid, used_memory(MiB), process_name
 *  原样透传）。uuid 只用于把进程回填到对应卡，不进 PerfGpuProc；pid 非数值→整行丢弃 */
export function parseGpuAppRow(s: string): { uuid: string; proc: PerfGpuProc } | null {
  const f = s.slice(2).split(',')
  if (f.length < 4) return null
  const uuid = f[0].trim()
  const pid = Number(f[1].trim())
  if (uuid === '' || !Number.isFinite(pid) || pid <= 0) return null
  const mem = Number(f[2].trim())
  return {
    uuid,
    proc: {
      pid: Math.round(pid),
      mem: Math.max(0, Number.isFinite(mem) ? mem : 0) * 1024 * 1024,
      name: f.slice(3).join(',').trim()
    }
  }
}

/** 由 lsblk 树 + df 挂载点 + 磁盘扇区计数器组装 PerfDisk[]（按挂载点匹配分区） */
function buildDisks(
  nodes: LsblkNode[],
  dfRows: DfRow[],
  sectors: Record<string, SectorCounter>,
  lastSectors: Record<string, SectorCounter> | null,
  dt: number
): PerfDisk[] {
  const disks: PerfDisk[] = []
  for (const node of nodes) {
    if (node.type !== 'disk') continue
    const mounts: PerfDiskMount[] = []
    for (const part of nodes.filter((n) => n.type === 'part' && n.pkname === node.name)) {
      const df = part.mount ? dfRows.find((d) => d.mount === part.mount) : undefined
      if (!df) continue
      mounts.push({
        device: part.name,
        mount: df.mount,
        fstype: df.fstype,
        size: df.size,
        used: df.used,
        avail: df.avail,
        usePct: df.size > 0 ? Math.round((df.used / df.size) * 1000) / 10 : 0
      })
    }
    let readBps: number | null = null
    let writeBps: number | null = null
    const cur = sectors[node.name]
    const prev = lastSectors?.[node.name]
    if (cur && prev && dt > 0.5) {
      readBps = Math.max(0, Math.round(((cur.read - prev.read) * 512) / dt))
      writeBps = Math.max(0, Math.round(((cur.write - prev.write) * 512) / dt))
    }
    disks.push({ name: node.name, total: node.size, readBps, writeBps, mounts })
  }
  return disks
}

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v))
}
