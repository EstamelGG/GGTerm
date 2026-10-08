import { EventEmitter } from 'node:events'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import type { Client, ClientChannel } from 'ssh2'
import { Client as RealClient, Server as SshServer, utils } from 'ssh2'
import { afterEach, expect, it, vi } from 'vitest'
import { PortForwardManager, type ForwardLink } from '../src/main/ssh/portForwardManager'
import type { PortForwardInput } from '../src/shared/portForward'

const servers: Server[] = []
const sockets = new Set<Socket>()
const managers: PortForwardManager[] = []
const sshCleanup: Array<() => Promise<void>> = []
const track = (socket: Socket): Socket => {
  sockets.add(socket)
  socket.on('error', () => {})
  socket.once('close', () => sockets.delete(socket))
  return socket
}
async function listen(server: Server, port = 0): Promise<number> {
  servers.push(server)
  server.on('connection', track)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  return (server.address() as { port: number }).port
}
async function freePort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
async function echo(): Promise<number> {
  return listen(createServer((socket) => socket.pipe(socket)))
}

/** TCP 实测转发链路；SSH 控制面模拟服务端注册与 direct-tcpip 通道。 */
class SshClient extends EventEmitter {
  remote = new Map<number, Server>()
  cancellations = 0
  forwardOut(
    _source: string,
    _port: number,
    host: string,
    port: number,
    callback: (error: Error | undefined, channel?: ClientChannel) => void
  ): void {
    const socket = track(createConnection({ host, port, allowHalfOpen: true }))
    socket.once('connect', () => callback(undefined, socket as unknown as ClientChannel))
    socket.once('error', (err) => callback(err))
  }
  forwardIn(address: string, port: number, callback: (err?: Error) => void): void {
    const server = createServer({ allowHalfOpen: true }, (socket) =>
      this.emit(
        'tcp connection',
        { destIP: address, destPort: port, srcIP: '127.0.0.1', srcPort: socket.remotePort },
        () => socket,
        () => socket.destroy()
      )
    )
    void listen(server, port)
      .then(() => {
        this.remote.set(port, server)
        callback()
      })
      .catch(callback)
  }
  unforwardIn(_address: string, port: number, callback: () => void): void {
    this.cancellations++
    const server = this.remote.get(port)
    this.remote.delete(port)
    if (server?.listening) server.close(callback)
    else callback()
  }
}

function setup(client = new SshClient()): { manager: PortForwardManager; link: ForwardLink } {
  const link = {
    activeClient: client as unknown as Client | null,
    phase: 'connected',
    offlineReason: '',
    waitForActive: async () => {}
  }
  const manager = new PortForwardManager(
    async () => link,
    () => {},
    () => {}
  )
  managers.push(manager)
  return { manager, link }
}
const input = (
  port: number,
  target: number,
  type: 'local' | 'remote' = 'local'
): PortForwardInput => ({
  name: 'test',
  hostId: 'host',
  type,
  listenAddress: '127.0.0.1',
  listenPort: port,
  targetHost: '127.0.0.1',
  targetPort: target,
  startPolicy: 'manual'
})
async function exchange(port: number, text = 'hello'): Promise<Socket> {
  const socket = track(createConnection({ host: '127.0.0.1', port }))
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.once('connect', () => socket.write(text))
    socket.once('data', (data) => {
      expect(data.toString()).toBe(text)
      resolve()
    })
  })
  return socket
}
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose()
  for (const socket of sockets) socket.destroy()
  for (const cleanup of sshCleanup.splice(0)) await cleanup()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (server.listening) server.close(() => resolve())
          else resolve()
        })
    )
  )
  vi.restoreAllMocks()
})

it('本地转发传输 TCP 数据并统计，停止关闭连接、释放端口，可再次启动', async () => {
  const target = await echo()
  const port = await freePort()
  const { manager } = setup()
  const rule = manager.configure(input(port, target))
  await manager.start(rule.id)
  const socket = await exchange(port)
  expect(manager.get(rule.id)).toMatchObject({
    status: 'running',
    connections: 1,
    bytesUp: 5,
    bytesDown: 5
  })
  await manager.stop(rule.id)
  await vi.waitFor(() => expect(socket.destroyed).toBe(true))
  expect(manager.get(rule.id)).toMatchObject({ status: 'stopped', connections: 0 })
  await manager.start(rule.id)
  await exchange(port, 'restart')
})

it('远程转发注册监听，将远端 TCP 连接交给本机目标，停止取消监听', async () => {
  const target = await echo()
  const port = await freePort()
  const client = new SshClient()
  const { manager } = setup(client)
  const rule = manager.configure(input(port, target, 'remote'))
  await manager.start(rule.id)
  await exchange(port, 'remote')
  expect(manager.get(rule.id)).toMatchObject({ status: 'running', connections: 1 })
  expect(await manager.probe(rule.id)).toMatchObject({ reachable: true, error: null })
  await manager.stop(rule.id)
  expect(client.cancellations).toBe(1)
  expect(client.listenerCount('tcp connection')).toBe(0)
  await manager.start(rule.id)
  await exchange(port)
})

it('监听成功与目标可达独立，目标失败保留监听并记录原因', async () => {
  const port = await freePort()
  const target = await freePort()
  const { manager } = setup()
  const rule = manager.configure(input(port, target))
  await manager.start(rule.id)
  expect(await manager.probe(rule.id)).toMatchObject({ reachable: false })
  track(createConnection({ host: '127.0.0.1', port }))
  await vi.waitFor(() => expect(manager.get(rule.id).error).toContain('ECONNREFUSED'))
  expect(manager.get(rule.id).status).toBe('running')
})

it('端口冲突不改变原规则，修改运行中的规则被拒绝', async () => {
  const occupied = await echo()
  const { manager } = setup()
  const rule = manager.configure(input(occupied, occupied))
  await expect(manager.start(rule.id)).rejects.toThrow('EADDRINUSE')
  expect(manager.get(rule.id)).toMatchObject({ status: 'error', listenPort: occupied })
  const running = manager.configure(input(await freePort(), occupied))
  await manager.start(running.id)
  expect(() => manager.configure(input(running.listenPort, occupied), running.id)).toThrow('Stop')
  const duplicate = manager.configure(
    input(running.listenPort, occupied),
    undefined,
    'other-session'
  )
  await expect(manager.start(duplicate.id, 'other-session')).rejects.toThrow('already used')
})

it('断线关闭旧连接，SSH 恢复重建监听，主动断开后停止', async () => {
  const target = await echo()
  const port = await freePort()
  const { manager, link } = setup()
  const rule = manager.configure(input(port, target))
  await manager.start(rule.id)
  const socket = await exchange(port)
  Object.assign(link, { activeClient: null, phase: 'reconnecting' })
  await vi.waitFor(() => expect(manager.get(rule.id).status).toBe('reconnecting'), {
    timeout: 1500
  })
  await vi.waitFor(() => expect(socket.destroyed).toBe(true))
  Object.assign(link, { activeClient: new SshClient(), phase: 'connected' })
  await vi.waitFor(() => expect(manager.get(rule.id).status).toBe('running'), { timeout: 1500 })
  await exchange(port, 'restored')
  Object.assign(link, { activeClient: null, phase: 'idle' })
  await vi.waitFor(() => expect(manager.get(rule.id).status).toBe('stopped'), { timeout: 1500 })
})

it('启动过程中停止按顺序清理，不留下迟到的监听端口', async () => {
  const port = await freePort()
  const target = await echo()
  const { manager, link } = setup()
  let ready!: () => void
  link.waitForActive = () =>
    new Promise<void>((resolve) => {
      ready = resolve
    })
  const rule = manager.configure(input(port, target, 'remote'))
  const starting = manager.start(rule.id)
  await vi.waitFor(() => expect(ready).toBeTypeOf('function'))
  const stopping = manager.stop(rule.id)
  ready()
  await Promise.all([starting, stopping])
  expect(manager.get(rule.id).status).toBe('stopped')
  const replacement = createServer()
  await listen(replacement, port)
})

it('对话归属隔离，清理临时规则，接管和保存规则在重启后保持停止', async () => {
  const { manager } = setup()
  const user = manager.configure(input(12001, 3306))
  const temporary = manager.configure(input(12002, 3306), undefined, 'session-a')
  expect(() => manager.get(user.id, 'session-a')).toThrow('another owner')
  expect(() => manager.get(temporary.id, 'session-b')).toThrow('another owner')
  await expect(manager.stop(temporary.id, 'session-b')).rejects.toThrow('another owner')
  await manager.closeSession('session-a')
  expect(manager.list().map((r) => r.id)).toEqual([user.id])
  const adopted = manager.configure(input(12003, 3306), undefined, 'session-a')
  manager.adopt(adopted.id)
  await manager.closeSession('session-a')
  expect(manager.get(adopted.id).owner).toBe('user')
  const restored = setup().manager
  restored.load(manager.list().map((rule) => ({ ...rule, status: 'running', connections: 2 })))
  expect(restored.list().every((rule) => rule.status === 'stopped' && rule.connections === 0)).toBe(
    true
  )
})

it('拒绝非法端口和地址，不把监听规则解释成命令', () => {
  const { manager } = setup()
  expect(() => manager.configure({ ...input(0, 3306) })).toThrow('Port')
  expect(() =>
    manager.configure({ ...input(8080, 3306), listenAddress: 'localhost;touch x' })
  ).toThrow('Listen address')
  expect(() => manager.configure({ ...input(8080, 3306), targetHost: 'host\ncommand' })).toThrow(
    'target host'
  )
})

it.each(['local', 'remote'] as const)(
  '保留 %s 转发的 TCP 半关闭，发送请求结束后仍收到目标响应',
  async (type) => {
    const target = await listen(
      createServer({ allowHalfOpen: true }, (socket) => {
        socket.on('data', () => {})
        socket.once('end', () => setTimeout(() => socket.end('response-after-fin'), 20))
      })
    )
    const { manager } = setup()
    const rule = manager.configure(input(await freePort(), target, type))
    await manager.start(rule.id)
    const socket = track(createConnection({ host: '127.0.0.1', port: rule.listenPort }))
    const result = await new Promise<string>((resolve, reject) => {
      let response = ''
      socket.once('connect', () => socket.end('request'))
      socket.on('data', (data) => {
        response += data.toString()
      })
      socket.once('end', () => resolve(response))
      socket.once('error', reject)
    })
    expect(result).toBe('response-after-fin')
  }
)

it('关闭用户 SSH 不影响同主机 Agent 转发，删除主机则停止转发并保留全部规则', async () => {
  const target = await echo()
  const { manager } = setup()
  const user = manager.configure(input(await freePort(), target))
  const agent = manager.configure(input(await freePort(), target), undefined, 'session-a')
  await manager.start(user.id)
  await manager.start(agent.id, 'session-a')
  await manager.closeHost('host', 'user')
  expect(manager.get(user.id).status).toBe('stopped')
  expect(manager.get(agent.id).status).toBe('running')
  await exchange(agent.listenPort)
  await manager.detachHost('host')
  expect(manager.list()).toHaveLength(2)
  expect(manager.list().every((rule) => rule.status === 'stopped')).toBe(true)
})

it('仅自动启动该主机的保存规则，SSH 失败后可手动再次启动', async () => {
  const target = await echo()
  const { manager, link } = setup()
  const automatic = manager.configure({
    ...input(await freePort(), target),
    startPolicy: 'on-connect'
  })
  const manual = manager.configure(input(await freePort(), target))
  const temporary = manager.configure(
    { ...input(await freePort(), target), startPolicy: 'on-connect' },
    undefined,
    'session-a'
  )
  manager.autoStart('host')
  await vi.waitFor(() => expect(manager.get(automatic.id).status).toBe('running'))
  expect(manager.get(manual.id).status).toBe('stopped')
  expect(manager.get(temporary.id)).toMatchObject({ status: 'stopped', startPolicy: 'manual' })
  Object.assign(link, { activeClient: null, phase: 'offline', offlineReason: 'auth failed' })
  await vi.waitFor(() => expect(manager.get(automatic.id).status).toBe('error'), { timeout: 1500 })
  Object.assign(link, { activeClient: new SshClient(), phase: 'connected' })
  await manager.start(automatic.id)
  await exchange(automatic.listenPort)
})

it('通过真实 ssh2 握手与通道验证本地、远程转发和服务端拒绝', async () => {
  const peers = new Set<Parameters<ConstructorParameters<typeof SshServer>[1]>[0]>()
  const remoteListeners = new Map<number, Server>()
  const ssh = new SshServer(
    { hostKeys: [utils.generateKeyPairSync('ed25519').private] },
    (peer) => {
      peers.add(peer)
      peer.on('error', () => {})
      peer.once('close', () => peers.delete(peer))
      peer.on('authentication', (context) => context.accept())
      peer.on('tcpip', (accept, reject, details) => {
        const socket = track(createConnection({ host: details.destIP, port: details.destPort }))
        socket.once('error', reject)
        socket.once('connect', () => {
          socket.removeListener('error', reject)
          const channel = accept()
          channel.on('error', () => socket.destroy())
          channel.once('close', () => socket.destroy())
          socket.once('close', () => channel.destroy())
          socket.pipe(channel).pipe(socket)
        })
      })
      peer.on('request', (accept, reject, name, details) => {
        if (name === 'cancel-tcpip-forward') {
          const server = remoteListeners.get(details.bindPort)
          remoteListeners.delete(details.bindPort)
          if (server?.listening) server.close(() => accept?.())
          else accept?.()
          return
        }
        if (details.bindAddr !== '127.0.0.1') {
          reject?.()
          return
        }
        const server = createServer((socket) => {
          peer.forwardOut(
            details.bindAddr,
            details.bindPort,
            socket.remoteAddress ?? '127.0.0.1',
            socket.remotePort ?? 0,
            (error, channel) => {
              if (error) {
                socket.destroy()
                return
              }
              channel.on('error', () => socket.destroy())
              channel.once('close', () => socket.destroy())
              socket.once('close', () => channel.destroy())
              socket.pipe(channel).pipe(socket)
            }
          )
        })
        void listen(server, details.bindPort)
          .then(() => {
            remoteListeners.set(details.bindPort, server)
            accept?.()
          })
          .catch(() => reject?.())
      })
    }
  )
  await new Promise<void>((resolve) => ssh.listen(0, '127.0.0.1', resolve))
  const client = new RealClient()
  client.on('error', () => {})
  sshCleanup.push(async () => {
    client.end()
    for (const peer of peers) peer.end()
    await new Promise<void>((resolve) => ssh.close(() => resolve()))
  })
  await new Promise<void>((resolve, reject) => {
    client.once('ready', resolve)
    client.once('error', reject)
    client.connect({
      host: '127.0.0.1',
      port: (ssh.address() as { port: number }).port,
      username: 'test',
      password: 'test'
    })
  })
  const link: ForwardLink = {
    activeClient: client,
    phase: 'connected',
    offlineReason: '',
    waitForActive: async () => {}
  }
  const manager = new PortForwardManager(
    async () => link,
    () => {},
    () => {}
  )
  managers.push(manager)
  const target = await echo()
  const local = manager.configure(input(await freePort(), target))
  await manager.start(local.id)
  await exchange(local.listenPort, 'real-local')
  expect(await manager.probe(local.id)).toMatchObject({ reachable: true })
  const remote = manager.configure(input(await freePort(), target, 'remote'))
  await manager.start(remote.id)
  await exchange(remote.listenPort, 'real-remote')
  await manager.stop(remote.id)
  await manager.start(remote.id)
  await exchange(remote.listenPort, 'real-restart')
  const denied = manager.configure({
    ...input(await freePort(), target, 'remote'),
    listenAddress: '0.0.0.0'
  })
  await expect(manager.start(denied.id)).rejects.toThrow()
  expect(manager.get(denied.id).status).toBe('error')
  await manager.stop(local.id)
  await manager.stop(remote.id)
}, 10000)
