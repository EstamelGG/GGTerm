import { randomUUID } from 'node:crypto'
import { createConnection, createServer, isIP, type Server, type Socket } from 'node:net'
import type { Client, ClientChannel, TcpConnectionDetails } from 'ssh2'
import type { PortForward, PortForwardInput } from '../../shared/portForward'

export interface ForwardLink {
  readonly activeClient: Client | null
  readonly phase: string
  readonly offlineReason: string
  waitForActive(): Promise<void>
}

interface Runtime {
  link?: ForwardLink
  client?: Client
  server?: Server
  remoteListener?: (
    details: TcpConnectionDetails,
    accept: () => ClientChannel,
    reject: () => void
  ) => void
  streams: Set<Socket | ClientChannel>
  binding: boolean
  remoteBound: boolean
  pendingBind?: Promise<void>
}

/** 网络生命周期的唯一所有者；UI 与 Agent 共用，运行资源不落盘。 */
export class PortForwardManager {
  private rules = new Map<string, PortForward>()
  private runtimes = new Map<string, Runtime>()
  private operations = new Map<string, Promise<unknown>>()
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private resolveLink: (rule: PortForward) => Promise<ForwardLink>,
    private changed: (rules: PortForward[]) => void,
    private saved: (rules: PortForward[]) => void
  ) {}

  load(rules: PortForward[]): void {
    for (const rule of rules)
      this.rules.set(rule.id, this.reset({ ...rule, owner: 'user', sessionId: undefined }))
  }

  list(): PortForward[] {
    return [...this.rules.values()].map((r) => ({ ...r }))
  }

  private reset(rule: PortForward): PortForward {
    return { ...rule, status: 'stopped', connections: 0, bytesUp: 0, bytesDown: 0, error: null }
  }

  get(id: string, sessionId?: string): PortForward {
    const rule = this.rules.get(id)
    if (!rule) throw new Error('Port forward not found')
    if (sessionId && (rule.owner !== 'agent' || rule.sessionId !== sessionId))
      throw new Error('This port forward belongs to another owner')
    return rule
  }

  configure(input: PortForwardInput, id?: string, sessionId?: string): PortForward {
    this.validate(input)
    const old = id ? this.get(id, sessionId) : undefined
    if (old && (this.runtimes.has(old.id) || this.operations.has(old.id)))
      throw new Error('Stop the port forward before editing')
    const rule = this.reset({
      ...input,
      name: input.name.trim() || `${input.type} ${input.listenPort} → ${input.targetPort}`,
      id: old?.id ?? randomUUID(),
      owner: old?.owner ?? (sessionId ? 'agent' : 'user'),
      sessionId: old?.sessionId ?? sessionId,
      status: 'stopped',
      connections: 0,
      bytesUp: 0,
      bytesDown: 0,
      error: null
    })
    if (rule.owner === 'agent') rule.startPolicy = 'manual'
    this.rules.set(rule.id, rule)
    this.persist()
    return { ...rule }
  }

  private validate(input: PortForwardInput): void {
    if (!input.hostId || !['local', 'remote'].includes(input.type))
      throw new Error('Invalid SSH host or forwarding type')
    if (!isIP(input.listenAddress))
      throw new Error('Listen address must be an IPv4 or IPv6 address')
    if (
      !input.targetHost.trim() ||
      /\s/.test(input.targetHost) ||
      input.targetHost.includes(String.fromCharCode(0))
    )
      throw new Error('Invalid target host')
    for (const port of [input.listenPort, input.targetPort])
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('Port must be between 1 and 65535')
    if (!['manual', 'on-connect'].includes(input.startPolicy))
      throw new Error('Invalid start policy')
  }

  private notify(): void {
    this.changed(this.list())
  }
  private persist(): void {
    this.saved(this.list().filter((r) => r.owner === 'user'))
    this.notify()
  }

  private ordered<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    this.operations.set(id, next)
    const clear = (): void => {
      if (this.operations.get(id) === next) this.operations.delete(id)
    }
    void next.then(clear, clear)
    return next
  }

  start(id: string, sessionId?: string): Promise<PortForward> {
    return this.ordered(id, () => this.startRule(id, sessionId))
  }

  private async startRule(id: string, sessionId?: string): Promise<PortForward> {
    const rule = this.get(id, sessionId)
    if (this.runtimes.has(id)) return { ...rule }
    // 本机监听端口在所有用户/对话之间共享；远端冲突由 SSH 服务端最终裁定。
    for (const [otherId] of this.runtimes) {
      const other = this.get(otherId)
      if (other.type !== rule.type || other.listenPort !== rule.listenPort) continue
      if (rule.type === 'remote' && other.hostId !== rule.hostId) continue
      if (
        other.listenAddress === rule.listenAddress ||
        ['0.0.0.0', '::'].includes(other.listenAddress) ||
        ['0.0.0.0', '::'].includes(rule.listenAddress)
      )
        throw new Error(`Listen port ${rule.listenPort} is already used by ${other.name}`)
    }
    const runtime: Runtime = { streams: new Set(), binding: true, remoteBound: false }
    this.runtimes.set(id, runtime)
    Object.assign(rule, { status: 'connecting', error: null, bytesUp: 0, bytesDown: 0 })
    this.notify()
    this.ensureTimer()
    try {
      runtime.link = await this.resolveLink(rule)
      await runtime.link.waitForActive()
      if (this.runtimes.get(id) !== runtime) return { ...rule }
      const client = runtime.link.activeClient
      if (!client) throw new Error('SSH connection is not active')
      runtime.pendingBind = this.bind(rule, runtime, client)
      await runtime.pendingBind
    } catch (error) {
      if (this.runtimes.get(id) === runtime) this.fail(rule, runtime, error)
      throw error
    } finally {
      runtime.binding = false
    }
    return { ...rule }
  }

  private ensureTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      for (const [id, runtime] of this.runtimes) {
        const rule = this.get(id)
        if (!runtime.link || runtime.binding) continue
        const client = runtime.link.activeClient
        if (!client) {
          if (runtime.link.phase === 'idle') {
            void this.stop(id)
            continue
          }
          if (runtime.link.phase === 'offline') {
            this.fail(
              rule,
              runtime,
              new Error(runtime.link.offlineReason || 'SSH connection failed')
            )
            continue
          }
          this.release(rule, runtime)
          rule.status = 'reconnecting'
          rule.error = runtime.link.offlineReason || null
        } else if (client !== runtime.client) {
          this.release(rule, runtime)
          runtime.binding = true
          runtime.pendingBind = this.bind(rule, runtime, client)
          void runtime.pendingBind
            .catch((err) => {
              if (this.runtimes.get(id) === runtime) this.fail(rule, runtime, err)
            })
            .finally(() => {
              runtime.binding = false
            })
        }
      }
      this.notify()
      if (!this.runtimes.size && this.timer) {
        clearInterval(this.timer)
        this.timer = undefined
      }
    }, 500)
    this.timer.unref()
  }

  private current(rule: PortForward, runtime: Runtime, client: Client): boolean {
    return this.runtimes.get(rule.id) === runtime && runtime.link?.activeClient === client
  }

  private async bind(rule: PortForward, runtime: Runtime, client: Client): Promise<void> {
    runtime.client = client
    rule.status = 'starting'
    this.notify()
    if (rule.type === 'local') {
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        socket.on('error', (err) => this.connectionError(rule, err))
        runtime.streams.add(socket)
        socket.once('close', () => runtime.streams.delete(socket))
        if (!this.current(rule, runtime, client)) {
          socket.destroy()
          return
        }
        socket.pause()
        client.forwardOut(
          socket.remoteAddress ?? '127.0.0.1',
          socket.remotePort ?? 0,
          rule.targetHost,
          rule.targetPort,
          (err, channel) => {
            if (err || !channel) {
              this.connectionError(rule, err ?? new Error('Target refused connection'))
              socket.destroy()
              return
            }
            if (!this.current(rule, runtime, client) || socket.destroyed) {
              channel.destroy()
              socket.destroy()
              return
            }
            this.bridge(rule, runtime, socket, channel)
          }
        )
      })
      runtime.server = server
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(rule.listenPort, rule.listenAddress, () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      server.on('error', (err) => {
        if (this.runtimes.get(rule.id) === runtime) this.fail(rule, runtime, err)
      })
    } else {
      runtime.remoteListener = (details, accept) => {
        if (details.destPort !== rule.listenPort || details.destIP !== rule.listenAddress) return
        const channel = accept()
        channel.on('error', (err) => this.connectionError(rule, err))
        if (!this.current(rule, runtime, client)) {
          channel.destroy()
          return
        }
        const socket = createConnection({
          host: rule.targetHost,
          port: rule.targetPort,
          allowHalfOpen: true
        })
        this.bridge(rule, runtime, socket, channel)
      }
      client.on('tcp connection', runtime.remoteListener)
      await new Promise<void>((resolve, reject) => {
        client.forwardIn(rule.listenAddress, rule.listenPort, (err) => {
          if (err) {
            reject(err)
            return
          }
          runtime.remoteBound = true
          if (!this.current(rule, runtime, client)) {
            client.unforwardIn(rule.listenAddress, rule.listenPort, () => {
              runtime.remoteBound = false
              resolve()
            })
            return
          }
          resolve()
        })
      })
    }
    if (!this.current(rule, runtime, client)) {
      this.release(rule, runtime)
      return
    }
    rule.status = 'running'
    rule.error = null
    this.notify()
  }

  private bridge(
    rule: PortForward,
    runtime: Runtime,
    socket: Socket,
    channel: ClientChannel
  ): void {
    runtime.streams.add(socket)
    runtime.streams.add(channel)
    rule.connections += 1
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      socket.destroy()
      channel.destroy()
      runtime.streams.delete(socket)
      runtime.streams.delete(channel)
      rule.connections = Math.max(0, rule.connections - 1)
    }
    socket.once('close', close)
    channel.once('close', close)
    socket.on('error', (err) => {
      this.connectionError(rule, err)
      close()
    })
    channel.on('error', (err) => {
      this.connectionError(rule, err)
      close()
    })
    socket.on('data', (data: Buffer) => {
      rule.bytesUp += data.length
    })
    channel.on('data', (data: Buffer) => {
      rule.bytesDown += data.length
    })
    socket.pipe(channel).pipe(socket)
    socket.resume()
  }

  private connectionError(rule: PortForward, error: Error): void {
    rule.error = error.message
    this.notify()
  }

  private release(rule: PortForward, runtime: Runtime): void {
    for (const stream of runtime.streams) stream.destroy()
    runtime.streams.clear()
    rule.connections = 0
    runtime.server?.close()
    runtime.server = undefined
    if (runtime.client && runtime.remoteListener)
      runtime.client.removeListener('tcp connection', runtime.remoteListener)
    if (runtime.client && runtime.remoteBound)
      runtime.client.unforwardIn(rule.listenAddress, rule.listenPort, () => {})
    runtime.remoteBound = false
    runtime.remoteListener = undefined
    runtime.client = undefined
  }

  private fail(rule: PortForward, runtime: Runtime, error: unknown): void {
    this.release(rule, runtime)
    this.runtimes.delete(rule.id)
    rule.status = 'error'
    rule.error = error instanceof Error ? error.message : String(error)
    this.notify()
  }

  async stop(id: string, sessionId?: string): Promise<PortForward> {
    return this.ordered(id, () => this.stopRule(id, sessionId))
  }

  private async stopRule(id: string, sessionId?: string): Promise<PortForward> {
    const rule = this.get(id, sessionId)
    const runtime = this.runtimes.get(id)
    this.runtimes.delete(id)
    if (runtime) {
      await runtime.pendingBind?.catch(() => {})
      // 等待远端取消监听 / 本地监听关闭后才允许再次启动，避免重启抢占旧端口。
      const server = runtime.server
      const client = runtime.client
      const remoteBound = runtime.remoteBound
      const closed = server?.listening
        ? new Promise<void>((resolve) => server.once('close', resolve))
        : Promise.resolve()
      runtime.remoteBound = false
      this.release(rule, runtime)
      await Promise.all([
        closed,
        client && remoteBound
          ? new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 3000)
              client.unforwardIn(rule.listenAddress, rule.listenPort, () => {
                clearTimeout(timer)
                resolve()
              })
            })
          : Promise.resolve()
      ])
    }
    rule.status = 'stopped'
    rule.error = null
    this.notify()
    return { ...rule }
  }

  async remove(id: string, sessionId?: string): Promise<void> {
    return this.ordered(id, async () => {
      await this.stopRule(id, sessionId)
      this.rules.delete(id)
      this.persist()
    })
  }

  adopt(id: string): PortForward {
    const rule = this.get(id)
    rule.owner = 'user'
    delete rule.sessionId
    this.persist()
    return { ...rule }
  }

  async closeSession(sessionId: string): Promise<void> {
    for (const rule of this.list()) if (rule.sessionId === sessionId) await this.remove(rule.id)
  }

  async closeHost(hostId: string, owner?: 'user' | 'agent'): Promise<void> {
    for (const rule of this.list())
      if (rule.hostId === hostId && (!owner || rule.owner === owner)) await this.stop(rule.id)
  }

  async detachHost(hostId: string): Promise<void> {
    await this.closeHost(hostId)
    this.persist()
  }

  autoStart(hostId: string): void {
    for (const rule of this.list())
      if (
        rule.hostId === hostId &&
        rule.owner === 'user' &&
        rule.startPolicy === 'on-connect' &&
        rule.status === 'stopped'
      )
        void this.start(rule.id).catch(() => {})
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const [id, runtime] of this.runtimes) this.release(this.get(id), runtime)
    this.runtimes.clear()
  }

  async probe(
    id: string,
    sessionId?: string
  ): Promise<{ reachable: boolean; latencyMs: number; error: string | null }> {
    const rule = this.get(id, sessionId)
    const started = Date.now()
    return new Promise((resolve) => {
      let done = false
      let stream: Socket | ClientChannel | undefined
      const finish = (error: Error | null): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        stream?.destroy()
        resolve({
          reachable: !error,
          latencyMs: Date.now() - started,
          error: error?.message ?? null
        })
      }
      const timer = setTimeout(() => finish(new Error('Target connection timed out')), 5000)
      if (rule.type === 'remote') {
        stream = createConnection({ host: rule.targetHost, port: rule.targetPort })
        stream.once('connect', () => finish(null))
        stream.once('error', finish)
      } else {
        const client = this.runtimes.get(id)?.link?.activeClient
        if (!client) {
          finish(new Error('Start the forward before testing its remote target'))
          return
        }
        client.forwardOut('127.0.0.1', 0, rule.targetHost, rule.targetPort, (err, channel) => {
          if (done) {
            channel?.destroy()
            return
          }
          stream = channel
          channel?.on('error', () => {})
          finish(err ?? null)
        })
      }
    })
  }
}
