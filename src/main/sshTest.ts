import { Client, type ClientChannel } from 'ssh2'
import type { AuthType, ConnectionSecrets } from '../shared/types'
import { selectAuth } from '../shared/sshAuth'
import { createHostVerifier } from './ssh/hostKeys'
import { listConnections } from './data/connections'
import { loadSecrets } from './data/secrets'

export interface SshTestInput {
  authType: AuthType
  host: string
  port: number
  username: string
  connectTimeout: number
  password: string
  privateKey: string
  passphrase: string
  /** 跳板链（有序，最外层在前）：测试按真实链路逐跳建立 */
  jumpHostIds: string[]
}

/** 单跳拨号：可带上游 sock（经跳板转发的 channel）；成功 resolve 已就绪 Client，失败自动断开并 reject */
function dial(
  host: string,
  port: number,
  username: string,
  connectTimeout: number,
  auth: AuthType,
  secrets: Partial<ConnectionSecrets>,
  sock?: ClientChannel
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const verifier = createHostVerifier(host, port)
    const conn = new Client()
    let settled = false
    const onReady = (): void => {
      if (settled) return
      settled = true
      conn.removeAllListeners('error')
      resolve(conn)
    }
    const onError = (err: Error): void => {
      if (settled) return
      settled = true
      try {
        conn.end()
      } catch {
        /* ignore */
      }
      reject(verifier.error() ?? err)
    }
    conn.once('ready', onReady).once('error', onError)
    conn.connect({
      host,
      port,
      username,
      readyTimeout: Math.max(500, connectTimeout),
      hostVerifier: verifier.verify,
      ...(sock ? { sock } : {}),
      ...selectAuth(auth, secrets)
    })
  })
}

function forward(client: Client, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, chan) => {
      if (err || !chan) reject(err ?? new Error('forwardOut failed'))
      else resolve(chan)
    })
  })
}

/**
 * 真实建连测试（对照 SSHConnect.test）：按真实链路（含跳板）逐跳建立，连上 + 认证通过即成功，立即断开。
 * 跳板用各自已存凭据；目标用表单当前值。首次自动记录各跳主机指纹，后续指纹变化时拒绝连接。
 */
export async function sshTest(input: SshTestInput): Promise<void> {
  await runTest(input)
}

async function runTest(input: SshTestInput): Promise<void> {
  const hops = (input.jumpHostIds ?? []).map((id) => {
    const hop = listConnections().find((c) => c.id === id)
    if (!hop) throw new Error(`Jump host not found: ${id}`)
    if (hop.authType === 'manual')
      throw new Error(`Jump host "${hop.name}" uses manual auth and cannot be a jump host`)
    return hop
  })
  const opened: Client[] = []
  try {
    let sock: ClientChannel | undefined
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i]
      const client = await dial(
        hop.host,
        hop.port,
        hop.username,
        hop.connectTimeout,
        hop.authType,
        loadSecrets(hop.id),
        sock
      )
      opened.push(client)
      const next = i + 1 < hops.length ? hops[i + 1] : input
      sock = await forward(client, next.host, next.port)
    }
    const target = await dial(
      input.host,
      input.port,
      input.username,
      input.connectTimeout,
      input.authType,
      input,
      sock
    )
    target.end()
  } finally {
    for (const client of opened) {
      try {
        client.end()
      } catch {
        /* ignore */
      }
    }
  }
}
