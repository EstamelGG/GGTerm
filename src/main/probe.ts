import * as net from 'net'
import * as dns from 'dns'

export interface ProbeTarget {
  id: string
  host: string
  port: number
}

export interface ProbeResult {
  id: string
  /** TCP 建连 RTT；null = 不可达（对照 HostLatencyProbe.connectLatencyMs） */
  ms: number | null
}

/** 非阻塞 TCP connect 计时（对照 Swift：poll + SO_ERROR 确认） */
function tcpConnectMs(host: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint()
    const socket = new net.Socket()
    let settled = false
    const done = (v: number | null): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(v)
    }
    socket.setTimeout(timeoutMs, () => done(null))
    socket.once('error', () => done(null))
    socket.connect(port, host, () => {
      const ns = Number(process.hrtime.bigint() - start)
      done(Math.max(1, Math.round(ns / 1e6)))
    })
  })
}

async function probeOne(target: ProbeTarget, timeoutMs: number): Promise<number | null> {
  let addrs: { address: string; family: number }[]
  try {
    addrs = await dns.promises.lookup(target.host, { all: true })
  } catch {
    return null
  }
  // 限制并发地址数，避免异常 DNS 记录拖垮探测
  const results = await Promise.all(
    addrs.slice(0, 4).map((a) => tcpConnectMs(a.address, target.port, timeoutMs))
  )
  const valid = results.filter((r): r is number => r !== null)
  return valid.length ? Math.min(...valid) : null
}

/** 批量探测；超时 3s（对照 Swift timeout: 3） */
export async function probeLatency(targets: ProbeTarget[]): Promise<ProbeResult[]> {
  return Promise.all(targets.map(async (t) => ({ id: t.id, ms: await probeOne(t, 3000) })))
}

/* ---------------- 详细探测（agent probe_latency 工具用） ---------------- */

export interface ProbeDetail {
  /** DNS 解析失败（与"端口不通"区分开，便于 agent 定位层级） */
  dnsError: boolean
  /** 端口是否可达（至少一次 TCP 建连成功） */
  reachable: boolean
  /** 每次探测的 RTT（ms）；null = 该次失败/超时 */
  samples: (number | null)[]
  /** 成功样本平均 RTT；null = 全部失败 */
  avgMs: number | null
  /** 成功样本最小 RTT */
  minMs: number | null
  /** 成功样本最大 RTT */
  maxMs: number | null
  /** 失败次数占比（0–1；DNS 失败时为 1） */
  lossRate: number
}

/**
 * 连续 N 次详细探测（顺序执行，每次独立 DNS 解析，与连接列表探测同源实现）：
 * 得出端口开放状态 + 平均/最小/最大延迟 + 丢包率。不涉及任何 SSH 认证。
 */
export async function probeDetail(host: string, port: number, attempts = 3): Promise<ProbeDetail> {
  const samples: (number | null)[] = []
  for (let i = 0; i < attempts; i++) {
    // 连续探测：语义即逐次顺序执行
    samples.push(await probeOne({ id: '', host, port }, 3000))
  }
  const ok = samples.filter((s): s is number => s !== null)
  // DNS 失败判定：全部失败时用一次显式 lookup 区分「域名解析失败」与「TCP 超时/拒绝」
  let dnsError = false
  if (ok.length === 0) {
    try {
      await dns.promises.lookup(host)
    } catch {
      dnsError = true
    }
  }
  return {
    dnsError,
    reachable: ok.length > 0,
    samples,
    avgMs: ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null,
    minMs: ok.length ? Math.min(...ok) : null,
    maxMs: ok.length ? Math.max(...ok) : null,
    lossRate: 1 - ok.length / attempts
  }
}
