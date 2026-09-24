import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { Client, type ClientChannel } from 'ssh2'
import { sshAlgorithms } from './algorithms'
import { selectAuth } from '../../shared/sshAuth'
import { createHostVerifier } from './hostKeys'
import type {
  ConnectionSecrets,
  HostConnection,
  HostLinkSnapshot,
  HostStateEvent,
  SftpMeasureEvent,
  SftpStateEvent,
  SftpTransferMirror
} from '../../shared/types'
import * as secretsStore from '../data/secrets'
import { listConnections } from '../data/connections'
import { errorMessage } from '../../shared/error'
import { appLog } from '../log'
import { t } from '../i18n'
import { SftpSession, execCommand } from './sftp'
import { OS_NAME_SCRIPT } from './remoteScripts'

/**
 * 对照 ATerminal-Swift Services/HostLink.swift + SSHTerminalController.swift：
 * 每主机一条共享 SSH 连接，全部 shell 的 PTY 通道与（阶段④的）SFTP 都复用它；
 * 断线/恢复由主机级信号统一驱动。
 *
 * 心跳：使用 ssh2 内置 keepalive（keepaliveInterval + keepaliveCountMax=3，即
 * OpenSSH 的 ServerAliveInterval / ServerAliveCountMax 同款协议级探测），连续
 * 3 次无应答触发 error 事件，由 declareLossAndReconnect 统一驱动重连；
 * 不再外露 RTT / 丢包计数。
 */

export type LinkPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline'

export type ShellStatus = 'connecting' | 'connected' | 'disconnected' | 'ended' | 'error'

export const MAX_RECONNECTS = 3
export const RECONNECT_DELAY_MS = 2000

export interface HostLinkEvents {
  onHostState: (payload: HostStateEvent) => void
  onShellState: (payload: {
    hostId: string
    shellId: string
    status: ShellStatus
    error?: string
  }) => void
  onShellData: (payload: { hostId: string; shellId: string; data: string }) => void
  onShellAnnounce: (payload: { hostId: string; shellId: string; text: string }) => void
  onSftpState: (payload: SftpStateEvent) => void
  onSftpTransfer: (payload: { hostId: string; transfer: SftpTransferMirror }) => void
  onSftpMeasure: (payload: SftpMeasureEvent) => void
}

export class ShellSession {
  readonly id = crypto.randomUUID()
  status: ShellStatus = 'disconnected'
  errorText = ''
  closedByUser = false
  dropAnnounced = false
  bootstrap: string | null
  cols = 120
  rows = 30
  private chan: ClientChannel | null = null
  private writeTail: Promise<void> = Promise.resolve()
  /** 渲染层是否已请求开通道（延迟启动协议；防渲染层故障卡死的兜底见 autoStartTimer） */
  private startRequested = false
  private autoStartTimer: NodeJS.Timeout | null = null
  /** 通道建立超时定时器（成员化：多次 start/断链可显式清理，防旧 timer 误杀新一轮连接） */
  private openTimer: NodeJS.Timeout | null = null
  /** 本次启动代际：断链/重启/新 start 递增，使旧 client.shell 回调与旧 timer 失效 */
  private startEpoch = 0

  constructor(
    private readonly link: HostLink,
    bootstrap?: string
  ) {
    this.bootstrap = bootstrap ?? null
    // 兜底：渲染层 3.5s 内未请求启动则自动开通道（正常路径 ~几十 ms）
    this.autoStartTimer = setTimeout(() => {
      this.autoStartTimer = null
      if (!this.startRequested && !this.closedByUser) this.start()
    }, 3500)
  }

  start(): void {
    this.startRequested = true
    if (this.autoStartTimer) {
      clearTimeout(this.autoStartTimer)
      this.autoStartTimer = null
    }
    this.closedByUser = false
    this.dropAnnounced = false
    this.writeTail = Promise.resolve()
    const client = this.link.activeClient
    if (!client) {
      this.setStatus('disconnected')
      return
    }
    // 幂等：已在建立中或已连接时不再重复开通道（autoStart 兜底 / 重连重建 / shell:start
    // 可能并发触发；重复 start 会开孤儿通道并把 connected 回跳成 connecting）
    if (this.status === 'connecting' || this.status === 'connected') return

    this.setStatus('connecting')
    const epoch = ++this.startEpoch
    this.clearOpenTimer()
    // 通道建立超时（对照 Swift：connecting 卡死无重连入口的死角）
    const timeoutMs = Math.min(10_000, Math.max(5_000, this.link.connection.connectTimeout))
    this.openTimer = setTimeout(() => {
      if (this.startEpoch !== epoch || this.status !== 'connecting') return
      this.openTimer = null
      this.chan = null
      this.setStatus('error', t('announce.channelTimeout'))
    }, timeoutMs)
    client.shell({ term: 'xterm-256color', cols: this.cols, rows: this.rows }, (err, chan) => {
      // 过期回调（断链/重启后旧 client 的迟到回调）：丢弃并关闭孤儿通道，防串扰
      if (this.startEpoch !== epoch) {
        if (chan) {
          try {
            chan.close()
          } catch {
            /* ignore */
          }
        }
        return
      }
      this.clearOpenTimer()
      if (err || !chan) {
        this.setStatus(this.link.isActive ? 'error' : 'disconnected', err?.message ?? '')
        return
      }
      this.chan = chan
      if (this.dropAnnounced) {
        this.dropAnnounced = false
        this.announce(t('announce.reconnected'))
      }
      this.setStatus('connected')
      this.deliverBootstrap()

      chan.on('data', (d: Buffer) => {
        if (this.chan !== chan) return
        const text = d.toString('utf8')
        this.link.events.onShellData({ hostId: this.link.hostId, shellId: this.id, data: text })
      })
      chan.stderr.on('data', (d: Buffer) => {
        if (this.chan !== chan) return
        const text = d.toString('utf8')
        this.link.events.onShellData({ hostId: this.link.hostId, shellId: this.id, data: text })
      })
      chan.on('close', () => {
        // 旧通道的 close（this.chan 已被新通道接管）忽略，避免误清/误报
        if (this.chan !== chan) return
        this.chan = null
        if (this.closedByUser) {
          this.setStatus('disconnected')
          return
        }
        // 通道干净关闭且主机链路仍活 = shell 正常退出（exit）
        if (this.link.isActive) {
          this.setStatus('ended')
          this.announce('会话已结束')
        } else {
          this.setStatus('disconnected')
        }
      })
    })
  }

  close(): void {
    this.closedByUser = true
    if (this.autoStartTimer) {
      clearTimeout(this.autoStartTimer)
      this.autoStartTimer = null
    }
    this.startEpoch += 1 // 作废进行中的通道回调，防迟到回调误置状态
    this.clearOpenTimer()
    this.chan?.close()
    this.chan = null
    this.setStatus('disconnected')
  }

  /** 主机级链路丢失 —— 该 shell 进入中断态；恢复仅由 hostLinkRestored 驱动 */
  hostLinkLost(): void {
    this.dropLink(t('announce.linkLost'))
  }

  /** 主机链路被主动关闭（AI 或用户断开）：同样转入断开态，等待手动重连 */
  hostClosed(): void {
    this.dropLink(t('announce.linkClosed'))
  }

  /** 链路失效的公共处理：作废通道回调、释放通道、播报一次、置为断开态 */
  private dropLink(message: string): void {
    if (this.closedByUser) return
    this.startEpoch += 1 // 作废进行中的通道回调，防断链后迟到回调把状态拉回 connected
    this.clearOpenTimer()
    this.chan = null
    this.writeTail = Promise.resolve()
    if (!this.dropAnnounced) {
      this.dropAnnounced = true
      this.announce(message)
    }
    if (this.status !== 'ended') this.setStatus('disconnected')
  }

  noteReconnectAttempt(attempt: number): void {
    if (this.closedByUser) return
    this.announce(t('announce.reconnecting', { attempt, total: MAX_RECONNECTS }))
  }

  noteOffline(): void {
    if (this.closedByUser) return
    this.announce('连接已断线，等待手动重连')
  }

  write(data: string): void {
    if (!this.chan || data === '') return
    // 串行化 stdin 写入（对照 writeTail：乱序会拆散 bracketed-paste 标记）
    this.writeTail = this.writeTail.then(
      () =>
        new Promise<void>((resolve) => {
          this.chan?.write(data, () => resolve())
          setTimeout(resolve, 2000)
        })
    )
  }

  /** 发送 SIGINT（Ctrl-C）：中断 shell 中的前台命令 */
  interrupt(): void {
    if (!this.chan) return
    try {
      this.chan.signal('INT')
    } catch {
      /* 通道不支持 signal 时忽略 */
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    try {
      this.chan?.setWindow(rows, cols, 0, 0)
    } catch {
      /* 通道未开时忽略 */
    }
  }

  private deliverBootstrap(): void {
    const command = this.bootstrap
    if (!command) return
    this.bootstrap = null
    setTimeout(() => {
      if (this.closedByUser || !this.chan) return
      this.write(command.endsWith('\n') ? command : `${command}\n`)
    }, 400)
  }

  private announce(text: string): void {
    this.link.events.onShellAnnounce({ hostId: this.link.hostId, shellId: this.id, text })
  }

  private clearOpenTimer(): void {
    if (this.openTimer) {
      clearTimeout(this.openTimer)
      this.openTimer = null
    }
  }

  private setStatus(status: ShellStatus, error = ''): void {
    this.status = status
    this.errorText = error
    this.link.events.onShellState({
      hostId: this.link.hostId,
      shellId: this.id,
      status,
      error: error || undefined
    })
  }
}

export class HostLink {
  readonly connectionId = randomUUID()
  phase: LinkPhase = 'idle'
  attempt = 0
  offlineReason = ''
  /** 进入当前 phase 的时刻（epoch ms）——链路状态的时间唯一事实来源（拓扑图倒计时/时长据此计算） */
  phaseSince = Date.now()
  readonly shells = new Map<string, ShellSession>()
  /** SFTP 会话（阶段④）：通道挂在共享连接上，断线/恢复随主机级信号驱动 */
  readonly sftp: SftpSession
  /** 手动认证凭据（仅内存，对照 sessionSecrets） */
  private sessionSecrets: ConnectionSecrets | null = null
  private client: Client | null = null
  /** 跳板链中间节点（目标 Client 的 sock 由末跳 forwardOut 提供；断开时级联关闭） */
  private jumpClients: Client[] = []
  /**
   * 临时跳板链覆盖（agent connect_via 设置；null = 用保存配置 conn.jumpHostIds）。
   * 运行期内有效（含自动重连），应用重启即回归保存配置 —— 不落盘、不改用户数据。
   */
  private jumpOverride: string[] | null = null
  /** 本次/最后一次拨号使用的跳板链 id（connecting 相位的图按它画） */
  private lastDialedIds: string[] = []
  /** 最后一次**实际建立**成功的跳板链 id（connected 及断开后保持 —— 图的事实来源） */
  private establishedIds: string[] = []
  private generation = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  /** 日志去重：上次已记录的 phase（emitState 会被重复调用） */
  private loggedPhase: LinkPhase | null = null

  constructor(
    readonly hostId: string,
    private conn: HostConnection,
    readonly events: HostLinkEvents,
    private readonly options: { probeOs?: boolean } = {}
  ) {
    this.sftp = new SftpSession(this, events)
  }

  get isActive(): boolean {
    return this.phase === 'connected'
  }

  get activeClient(): Client | null {
    return this.isActive ? this.client : null
  }

  get awaitingCredentials(): boolean {
    return this.conn.authType === 'manual' && this.sessionSecrets === null
  }

  get connection(): HostConnection {
    return this.conn
  }

  update(conn: HostConnection, secrets?: ConnectionSecrets): void {
    this.conn = conn
    if (secrets) this.sessionSecrets = secrets
  }

  /** phase 唯一写入口：同步刷新 phaseSince（时间事实来源），避免各处赋值漏记时刻 */
  private setPhase(next: LinkPhase): void {
    if (this.phase === next) return
    this.phase = next
    this.phaseSince = Date.now()
  }

  /** 连接（或 offline 后手动重连）；运行中为 no-op */
  start(): void {
    if (this.phase === 'connecting' || this.phase === 'connected' || this.phase === 'reconnecting')
      return
    this.generation += 1
    void this.connectLoop(0)
  }

  /** 拆链重连（连接参数变更时） */
  restart(): void {
    this.generation += 1
    this.teardownClient()
    void this.connectLoop(0)
  }

  /** 设置/清除临时跳板链（null = 回归保存配置）；变更即广播，拓扑图随之改画实际路由 */
  setJumpOverride(ids: string[] | null): void {
    this.jumpOverride = ids && ids.length > 0 ? ids : null
    this.emitState()
  }

  /**
   * 上报给拓扑图的跳板链 —— **事实优先，配置理论值不上图**：
   *  connected → 最后实际建立的链；connecting/reconnecting → 本次正在拨的链；
   *  offline/idle → 最后实际建立的链（断开保持，与倒计时环同语义）；
   *  从未建立成功过则退化为最后尝试的链（失败时能看到尝试过的路由）。
   */
  get effectiveJumpIds(): string[] {
    if (this.phase === 'connecting' || this.phase === 'reconnecting') return this.lastDialedIds
    return this.establishedIds.length > 0 ? this.establishedIds : this.lastDialedIds
  }

  /** 预采样本次拨号链（相位广播前取值，保证 connecting 一刻图就画对；解析失败保持旧值） */
  private previewDialedIds(): string[] {
    try {
      return this.resolveJumpHops().map((h) => h.id)
    } catch {
      return this.lastDialedIds
    }
  }

  shutdown(): void {
    this.generation += 1
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    // 先通知存活会话：终端因此立即进入断开态并播报（否则只会"卡死且毫无提示"）
    for (const s of this.shells.values()) s.hostClosed()
    this.sftp.stop()
    this.teardownClient()
    this.setPhase('idle')
    this.loggedPhase = null
    // 手动关闭也广播终态（拓扑图等依赖 host:state 的视图据此转入"已断开"态）
    this.emitState()
    appLog('ssh', `Connection "${this.conn.name}" closed`)
  }

  /**
   * 登记会话（不开通道）。延迟启动协议：渲染层先建 xterm 实例与镜像，
   * 再经 shell:start 请求开通道 —— 事件/输出必然晚于注册，无竞态（对齐本地控制台模式）。
   */
  addShell(bootstrap?: string): ShellSession {
    const shell = new ShellSession(this, bootstrap)
    this.shells.set(shell.id, shell)
    return shell
  }

  /** 渲染层就绪后请求开通道（幂等：重复调用/重连路径共用 start 的防护） */
  startShell(id: string): boolean {
    const shell = this.shells.get(id)
    if (!shell) return false
    if (!shell.closedByUser && shell.status !== 'ended') shell.start()
    return true
  }

  removeShell(id: string): void {
    const shell = this.shells.get(id)
    if (shell) {
      shell.close()
      this.shells.delete(id)
    }
  }

  private teardownClient(): void {
    const client = this.client
    this.client = null
    if (client) {
      client.removeAllListeners()
      client.end()
    }
    // 级联关闭跳板链中间节点（每目标独立建链，不复用）
    for (const jump of this.jumpClients) {
      try {
        jump.removeAllListeners()
        jump.end()
      } catch {
        /* ignore */
      }
    }
    this.jumpClients = []
  }

  private async connectLoop(startingAttempt: number): Promise<void> {
    let attempt = startingAttempt
    for (;;) {
      this.attempt = attempt
      // 相位广播前先采样本次拨号链：connecting 一刻拓扑图就画「正在拨的路由」（事实，非配置）
      this.lastDialedIds = this.previewDialedIds()
      this.setPhase(attempt === 0 ? 'connecting' : 'reconnecting')
      this.emitState()
      if (attempt > 0) {
        for (const s of this.shells.values()) s.noteReconnectAttempt(attempt)
      }

      const gen = this.generation
      try {
        const client = await this.connectOnce()
        if (gen !== this.generation) {
          client.end()
          return
        }
        this.client = client
        this.setPhase('connected')
        this.emitState()
        client.on('close', () => this.handleDisconnect(gen))
        client.on('error', (err: Error) => {
          if (gen !== this.generation) return
          this.declareLossAndReconnect(err.message)
        })
        // 链路（重）建立：重建所有存活会话（心跳由 ssh2 内置 keepalive 负责）
        for (const s of this.shells.values()) {
          if (!s.closedByUser && s.status !== 'ended') s.start()
        }
        this.sftp.hostLinkRestored()
        // 兜底采集主机系统名（性能监控不可用/未开时，OS 图标缓存靠会话链路刷新）
        if (this.options.probeOs !== false) void this.probeOsName(client)
        return
      } catch (err) {
        const message = errorMessage(err)
        // 记录最新失败原因（重连中 waitForActive/connect 工具可读取），最终 offline 时亦复用
        this.offlineReason = message
        attempt += 1
        if (attempt > MAX_RECONNECTS || (err as { code?: string }).code === 'HOST_KEY_CHANGED') {
          this.setPhase('offline')
          this.offlineReason = message
          this.emitState()
          for (const s of this.shells.values()) s.noteOffline()
          return
        }
        await new Promise<void>((resolve) => {
          this.reconnectTimer = setTimeout(resolve, RECONNECT_DELAY_MS)
        })
        if (gen !== this.generation) return
      }
    }
  }

  /** 解析跳板链（不含目标）：id 必须存在且非手动认证；扁平链不递归展开各跳自身的链。
   *  临时覆盖优先于保存配置（agent connect_via 的运行期路由）。 */
  private resolveJumpHops(): HostConnection[] {
    const ids = this.jumpOverride ?? this.conn.jumpHostIds ?? []
    if (ids.length === 0) return []
    const all = listConnections()
    return ids.map((id) => {
      const hop = all.find((c) => c.id === id)
      if (!hop) throw new Error(`Jump host not found: ${id}`)
      if (hop.authType === 'manual')
        throw new Error(`Jump host "${hop.name}" uses manual auth and cannot be a jump host`)
      return hop
    })
  }

  /** 单跳连接：可带上游 sock（经跳板转发的 channel）与凭据覆盖（仅目标主机的手动登录凭据） */
  private connectHop(
    hop: HostConnection,
    secretsOverride: ConnectionSecrets | null | undefined,
    sock?: ClientChannel
  ): Promise<Client> {
    return new Promise((resolve, reject) => {
      const verifier = createHostVerifier(hop.host, hop.port)
      // null 与 undefined 均表示无覆盖（对照原 sessionSecrets ?? 语义）；仅非空对象才是目标主机的手动登录凭据
      const hasOverride = secretsOverride != null
      const secrets = hasOverride
        ? secretsOverride
        : hop.authType === 'manual'
          ? null
          : secretsStore.loadSecrets(hop.id)
      const conn = new Client()
      let settled = false
      const onReady = (): void => {
        if (settled) return
        settled = true
        // 关 Nagle：SFTP/PTY 是小包请求-应答模式，Nagle×延迟ACK 每往返多 ~40-80ms（延迟换吞吐，交互场景划算）
        conn.setNoDelay(true)
        conn.removeAllListeners('error')
        resolve(conn)
      }
      const onError = (err: Error): void => {
        if (settled) return
        settled = true
        conn.end()
        reject(verifier.error() ?? err)
      }
      conn.once('ready', onReady)
      conn.once('error', onError)

      // 心跳交给 ssh2 内置 keepalive（每跳独立配置，随跳板连接自身参数）
      conn.connect({
        algorithms: sshAlgorithms(hop.strictKex),
        host: hop.host,
        port: hop.port,
        username: hop.username,
        readyTimeout: Math.max(500, hop.connectTimeout),
        keepaliveInterval: hop.keepaliveInterval,
        keepaliveCountMax: 3,
        hostVerifier: verifier.verify,
        ...(sock ? { sock } : {}),
        ...selectAuth(hasOverride ? 'manual' : hop.authType, secrets ?? {})
      })
    })
  }

  /** 经上一跳转发到下一跳的 host:port（ssh 协议 direct-tcpip 通道） */
  private forwardOut(client: Client, host: string, port: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, host, port, (err, chan) => {
        if (err || !chan) reject(err ?? new Error('forwardOut failed'))
        else resolve(chan)
      })
    })
  }

  /** 建链：[跳板1, …, 跳板N, 目标] 逐跳握手（forwardOut channel 作为下一跳 sock）；任一跳失败关闭全部已建连接 */
  private async connectOnce(): Promise<Client> {
    const chain = [...this.resolveJumpHops(), this.conn]
    const jumpClients: Client[] = []
    try {
      let sock: ClientChannel | undefined
      for (let i = 0; i < chain.length - 1; i++) {
        const hopClient = await this.connectHop(chain[i], undefined, sock)
        jumpClients.push(hopClient)
        sock = await this.forwardOut(hopClient, chain[i + 1].host, chain[i + 1].port)
      }
      const target = await this.connectHop(this.conn, this.sessionSecrets, sock)
      this.jumpClients = jumpClients
      // 建链成功：记录实际建立的链（图的事实来源；此后即使配置被改，未重连前图不切换）
      this.establishedIds = chain.slice(0, -1).map((c) => c.id)
      return target
    } catch (err) {
      // 失败清理：关闭已建立的中间跳板（参考实现的泄漏缺陷在此修复）
      for (const jump of jumpClients) {
        try {
          jump.end()
        } catch {
          /* ignore */
        }
      }
      throw err
    }
  }

  /** 会话链路（重）建立后单次采集主机系统名并广播 os:sample（OS 图标缓存兜底路径）；失败静默 */
  async probeOsName(client: Client): Promise<void> {
    try {
      const out = await execCommand(client, OS_NAME_SCRIPT)
      const line = out
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('O '))
      const osName = line ? line.slice(2) : ''
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('os:sample', { hostId: this.hostId, osName })
      }
    } catch {
      /* 静默：链路刚建立即断开等瞬态，不值得记日志 */
    }
  }

  /** Socket close always invalidates the transport, even before a keepalive error arrives. */
  private handleDisconnect(gen: number): void {
    if (gen !== this.generation) return
    this.declareLossAndReconnect('SSH transport closed by peer')
  }

  /** 链路死亡唯一漏斗：通知会话，再固定次数重试，超限停车等手动 */
  private declareLossAndReconnect(reason: string): void {
    if (this.phase === 'offline' || this.phase === 'idle') return
    this.generation += 1
    this.offlineReason = reason
    this.teardownClient()
    for (const s of this.shells.values()) s.hostLinkLost()
    this.sftp.hostLinkLost()
    void this.connectLoop(1)
  }

  private emitState(): void {
    this.events.onHostState({
      hostId: this.hostId,
      phase: this.phase,
      since: this.phaseSince,
      attempt: this.phase === 'reconnecting' ? this.attempt : undefined,
      reason: this.phase === 'offline' ? this.offlineReason : undefined,
      awaiting: this.awaitingCredentials,
      // 实际生效的跳板链（含临时覆盖）：拓扑图按它画边，而不是保存配置
      jumpIds: this.effectiveJumpIds
    })
    this.logPhase()
  }

  /** phase 首次变迁时记日志（ssh 分类）；重连尝试次数在 connectLoop 里单独记 */
  private logPhase(): void {
    if (this.phase === this.loggedPhase) return
    this.loggedPhase = this.phase
    const name = this.conn.name
    if (this.phase === 'connecting') {
      appLog('ssh', `Connection "${name}" started`)
    } else if (this.phase === 'reconnecting') {
      // ssh2 内置 keepalive 超时的 message 固定为 'Keepalive timeout'（client.js sendKA）——识别后带配置参数，便于诊断
      const cause =
        this.offlineReason === 'Keepalive timeout'
          ? `keepalive timeout (${Math.round(this.conn.keepaliveInterval / 1000)}s × 3 unanswered)`
          : `disconnected: ${this.offlineReason}`
      appLog('ssh', `Connection "${name}" ${cause}, reconnecting`)
    } else if (this.phase === 'connected') {
      const el = ((Date.now() - this.phaseSince) / 1000).toFixed(1)
      appLog('ssh', `Connection "${name}" established (${el}s)`)
    } else if (this.phase === 'offline') {
      appLog('ssh', `Connection "${name}" offline (retry limit exceeded): ${this.offlineReason}`)
    }
  }

  emitCurrentState(): void {
    this.emitState()
  }

  /** 等待链路进入 connected（供 SFTP/AI connect；失败立即或超时抛出，附最新失败原因） */
  async waitForActive(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.isActive) return
      // 已判定离线：无需等满超时，直接带原因失败
      if (this.phase === 'offline') {
        throw new Error(`Connection failed — ${this.offlineReason || 'unknown reason'}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    const detail = this.offlineReason
      ? `reason: ${this.offlineReason}`
      : `current phase: ${this.phase} (possibly waiting for host response/auth)`
    throw new Error(
      `Connection not established within ${Math.round(timeoutMs / 1000)}s — ${detail}`
    )
  }
}

/** 主机注册表：hostId → HostLink */
const registry = new Map<string, HostLink>()

/**
 * 已断开链路的墓碑（hostId → 断开时刻）：removeLink 会清掉 registry，但拓扑图在刷新后
 * 仍需区分「本次运行从未连接」与「已断开」——故保留断开时刻。仅对仍存在的连接生效，
 * 连接被删除即自动消失（下次 getOrCreateLink 也会清掉）。
 */
const closedSince = new Map<string, number>()

export function getOrCreateLink(conn: HostConnection, events: HostLinkEvents): HostLink {
  closedSince.delete(conn.id)
  let link = registry.get(conn.id)
  if (link) {
    link.update(conn)
  } else {
    link = new HostLink(conn.id, conn, events)
    registry.set(conn.id, link)
  }
  return link
}

export function getLink(hostId: string): HostLink | undefined {
  return registry.get(hostId)
}

/** 已断开链路在拓扑图上的保留时长（与渲染层 OFFLINE_RING_MS / CSS topo-countdown 300s 对齐） */
const CLOSED_TTL_MS = 5 * 60 * 1000

/** 全部链路状态快照（拓扑图 / 连接列表状态列初始化用）：phase + 进入时刻 + 重试次数 + 失败原因 */
export function listLinks(): HostLinkSnapshot[] {
  const now = Date.now()
  const out: HostLinkSnapshot[] = []
  for (const [hostId, link] of registry) {
    // 保留态（软断开）超过 TTL 不再上报：与拓扑「断开 5 分钟后退场」一致，避免刷新后又冒出来
    if (link.phase === 'idle' && now - link.phaseSince >= CLOSED_TTL_MS) continue
    out.push({
      hostId,
      phase: link.phase,
      since: link.phaseSince,
      attempt: link.phase === 'reconnecting' ? link.attempt : undefined,
      reason: link.phase === 'offline' ? link.offlineReason : undefined,
      jumpIds: link.effectiveJumpIds
    })
  }
  // 已断开（registry 已清）：仍存在的连接补一条 idle 记录，刷新后拓扑得以分辨「从未连接 / 已断开」。
  // 超过 TTL 或连接已删除的墓碑顺手清理 —— 渲染层因此无需自行判断「打开时就已过期」。
  const saved = new Set(listConnections().map((c) => c.id))
  for (const [hostId, since] of [...closedSince]) {
    if (!saved.has(hostId) || Date.now() - since >= CLOSED_TTL_MS) {
      closedSince.delete(hostId)
      continue
    }
    if (registry.has(hostId)) continue
    out.push({ hostId, phase: 'idle', since })
  }
  return out
}

/** 对指定主机触发系统名单次采集并广播 os:sample（拓扑图等无缓存时兜底）；链路不在位则跳过 */
export function probeLinksOsName(hostIds: string[]): void {
  for (const hostId of hostIds) {
    const link = registry.get(hostId)
    const client = link?.activeClient
    if (link && client) void link.probeOsName(client)
  }
}

export function removeLink(hostId: string): void {
  const link = registry.get(hostId)
  if (link) {
    link.shutdown()
    registry.delete(hostId)
    // 记下断开时刻：刷新/重进页面后拓扑仍显示「已断开 + 倒计时环」，而非退回「从未连接」
    closedSince.set(hostId, Date.now())
  }
}
