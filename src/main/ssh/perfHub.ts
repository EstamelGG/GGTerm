import { isNetworkDevice } from '../../shared/device'
import { BrowserWindow } from 'electron'
import { Client } from 'ssh2'
import { sshAlgorithms } from './algorithms'
import { selectAuth } from '../../shared/sshAuth'
import { createHostVerifier } from './hostKeys'
import type { ConnectionSecrets, HostConnection, PerfSample } from '../../shared/types'
import { appLog } from '../log'
import * as connections from '../data/connections'
import * as secretsStore from '../data/secrets'
import { getPreferences } from '../data/prefs'
import { getLink } from './link'
import { PerfMonitor, HUB_INTERVAL_MS } from './perf'

/**
 * 性能探测枢纽（连接列表页"可见行"驱动）——hub 是唯一监控者，生命周期独立于终端会话：
 * - 渲染层 perf:watch 全量同步可见 hostId 集合，此处 diff：新增建条目、消失销毁
 * - client 来源动态选择：有活跃 HostLink → 借用共享连接 exec（零额外连接）；
 *   无活跃会话 → 懒建轻量专用连接（无心跳），会话断开自动落回、上线自动归还
 * - 失败按原因区分：登录失败（凭据被拒/无凭据/手动型）→ 停等（模块级持久），
 *   仅"编辑保存连接"（perfInvalidate）/删除连接/重启 app 后恢复；
 *   其他失败（网络不可达/超时等）→ 每个 10s 采样周期自动重试
 */

interface HubEntry {
  monitor: PerfMonitor
  conn: HostConnection
  /** 专用连接（懒建；意外断开置 null 下轮重建） */
  client: Client | null
  building: boolean
  /** 瞬时失败已记日志（连接成功后重置，避免 3s 重试刷屏） */
  failLogged: boolean
}

const entries = new Map<string, HubEntry>()
/** 当前 watch 的 hostId 集合（perfInvalidate 重建条目用） */
const watched = new Set<string>()
/**
 * 登录失败停等集合（模块级持久：条目随视口销毁重建不清除），
 * 仅"编辑保存连接"（perfInvalidate）/删除连接/重启 app 时清除
 */
const authFailedHosts = new Set<string>()

/** 轻量探测连接（对照 link.connectOnce 的精简版：无 keepalive、无 hostVerifier 之外的可选项） */
function connectProbeClient(conn: HostConnection, secrets: ConnectionSecrets): Promise<Client> {
  return new Promise((resolve, reject) => {
    const verifier = createHostVerifier(conn.host, conn.port)
    const client = new Client()
    let settled = false
    client.once('ready', () => {
      if (settled) return
      settled = true
      client.removeAllListeners('error')
      // ready 后 socket 错误（网络切换/休眠恢复可致 read EADDRNOTAVAIL）必须有持久监听，
      // 否则 client 'error' 无监听者会抛 uncaughtException 崩溃整个应用
      client.on('error', (err: Error) => {
        appLog('ssh', `Perf probe connection error: ${err.message}`, 'error')
        client.end() // 触发 close（已挂监听）→ 置空 e.client，下轮采样自动重建
      })
      // 关 Nagle：小包请求-应答模式免受 Nagle×延迟ACK 叠加延迟（同 link.connectOnce）
      client.setNoDelay(true)
      resolve(client)
    })
    client.once('error', (err: Error) => {
      if (settled) return
      settled = true
      client.end()
      reject(verifier.error() ?? err)
    })
    client.connect({
      algorithms: sshAlgorithms(conn.strictKex),
      host: conn.host,
      port: conn.port,
      username: conn.username,
      readyTimeout: Math.max(5000, conn.connectTimeout),
      keepaliveInterval: 0,
      hostVerifier: verifier.verify,
      ...selectAuth(conn.authType, secrets)
    })
  })
}

/** 条目的 client 来源：活跃 HostLink 借用共享连接；否则懒建/复用专用连接（会话上线自动归还） */
async function clientFor(hostId: string): Promise<Client | null> {
  const e = entries.get(hostId)
  if (!e || authFailedHosts.has(hostId)) return null
  const linkClient = getLink(hostId)?.activeClient ?? null
  if (linkClient) {
    // 会话在用共享连接：释放专用探测连接（如有），零额外连接
    if (e.client) {
      try {
        e.client.end()
      } catch {
        /* ignore */
      }
      e.client = null
    }
    return linkClient
  }
  if (e.client) return e.client
  if (e.building) return null

  if (e.conn.authType === 'manual') {
    authFailedHosts.add(hostId)
    appLog(
      'ssh',
      `Perf probe skipped "${e.conn.name}" (manual auth; takes effect after saving the connection)`
    )
    return null
  }
  const secrets = secretsStore.loadSecrets(hostId)
  if (!secrets.password && !secrets.privateKey) {
    authFailedHosts.add(hostId)
    appLog(
      'ssh',
      `Perf probe skipped "${e.conn.name}" (no stored credentials; takes effect after saving the connection)`
    )
    return null
  }

  e.building = true
  try {
    const client = await connectProbeClient(e.conn, secrets)
    client.once('close', () => {
      const cur = entries.get(hostId)
      if (cur?.client === client) cur.client = null // 意外断开：下轮采样时重建
    })
    e.client = client
    e.failLogged = false
    return client
  } catch (err) {
    const message = (err as Error).message
    // ssh2 认证失败带结构化标记 err.level === 'client-authentication'（正则兜底文案变化）
    const isAuthFailure =
      (err as { code?: string }).code === 'HOST_KEY_CHANGED' ||
      (err as { level?: string }).level === 'client-authentication' ||
      /authentication/i.test(message)
    if (isAuthFailure) {
      // 登录失败：凭据被拒——自动重试只会继续被拒，停等到编辑保存或重启
      authFailedHosts.add(hostId)
      appLog(
        'ssh',
        `Perf probe auth failed "${e.conn.name}": ${message} (retry after saving the connection or restarting)`,
        'error'
      )
    } else {
      // 网络/超时等其他原因：下个 10s 采样周期自动重试；日志每段只记一条，熔断每次都记账
      e.monitor.noteFailure()
      if (!e.failLogged) {
        e.failLogged = true
        appLog(
          'ssh',
          `Perf probe connection failed "${e.conn.name}": ${message} (auto retry every 10s)`,
          'error'
        )
      }
    }
    return null
  } finally {
    e.building = false
  }
}

function broadcast(sample: PerfSample): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('perf:sample', sample)
}

function disposeEntry(hostId: string): void {
  const e = entries.get(hostId)
  if (!e) return
  e.monitor.stop()
  try {
    e.client?.end()
  } catch {
    /* ignore */
  }
  entries.delete(hostId)
}

/** 渲染层可见集合全量同步（diff 内部处理）；空数组 = 全部销毁 */
export function perfWatch(hostIds: string[]): void {
  const want = getPreferences().perfMonitorDisabled ? new Set<string>() : new Set(hostIds)
  // 整体清空（页面切走/卸载或性能监控关闭）记一条汇总；行级 diff（视口滚动）不记，防刷屏
  if (want.size === 0 && watched.size > 0) {
    appLog(
      'ssh',
      `Perf sampling stopped (${watched.size} entries disposed: page hidden/unmounted or perf monitor disabled)`,
      'warning'
    )
  }
  watched.clear()
  for (const id of want) watched.add(id)
  for (const id of [...entries.keys()]) {
    if (!want.has(id)) disposeEntry(id)
  }
  for (const id of want) {
    if (!entries.has(id)) createEntry(id)
  }
}

/**
 * 性能列隐藏（窄窗口）→ 暂停全部采样计时器；条目、探测连接、最近样本全保留
 * （UI 已显示数据不变），列恢复可见后各条目按原间隔续跑
 */
let paused = false
export function perfSetPaused(value: boolean): void {
  if (paused === value) return
  paused = value
  const count = entries.size
  for (const e of entries.values()) {
    if (value) e.monitor.pause()
    else e.monitor.resume()
  }
  if (count === 0) return
  appLog(
    'ssh',
    value ? `${count} perf samplings paused` : `${count} perf samplings resumed`,
    value ? 'warning' : 'info'
  )
}

/** 设置变更后重扫：全局开关切换时按当前 watch 集合重建/清空 */
export function perfRescan(): void {
  perfWatch([...watched])
}

/** 新建条目并启动采样（连接级禁用、配置跳板或无记录则跳过——跳板主机在内网，直连探测必然失败且无意义） */
function createEntry(hostId: string): void {
  const conn = connections.listConnections().find((c) => c.id === hostId)
  if (!conn || isNetworkDevice(conn) || conn.perfDisabled || (conn.jumpHostIds?.length ?? 0) > 0)
    return
  const entry: HubEntry = {
    conn,
    client: null,
    building: false,
    failLogged: false,
    monitor: null as unknown as PerfMonitor
  }
  entry.monitor = new PerfMonitor(hostId, () => clientFor(hostId), broadcast, conn.name, {
    intervalMs: HUB_INTERVAL_MS,
    collectNet: false,
    shouldSample: () => !isNetworkDevice(connections.listConnections().find((c) => c.id === hostId))
  })
  entries.set(hostId, entry)
  if (!paused) entry.monitor.start() // 暂停期新建的条目等恢复时统一续跑
}

/** 列表头手动刷新：全部 watch 条目清熔断 + 立即采样（成功即恢复自动周期） */
export function perfRefreshAll(): void {
  for (const e of entries.values()) e.monitor.refreshNow()
}

/** 连接/凭据被编辑保存：清除登录失败停等并重建条目（立即用新配置重连） */
export function perfInvalidate(hostId: string): void {
  authFailedHosts.delete(hostId)
  if (!watched.has(hostId)) return
  disposeEntry(hostId)
  createEntry(hostId)
}

/** 连接被删除：清理停等标记（配合 watch diff 的条目销毁） */
export function perfForget(hostId: string): void {
  authFailedHosts.delete(hostId)
}

/** 快照 = hub 各条目最近样本（页面打开时拉取，此后增量走 perf:sample） */
export function perfSnapshotAll(): Record<string, PerfSample> {
  const out: Record<string, PerfSample> = {}
  for (const [id, e] of entries) {
    if (e.monitor.last) out[id] = e.monitor.last
  }
  return out
}
