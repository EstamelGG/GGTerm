import { z } from 'zod'
import type { Client } from 'ssh2'
import { listConnections } from '../../data/connections'
import { getOrCreateAgentLink } from '../agentLinks'
import type { HostLink } from '../../ssh/link'
import type { AgentTool } from '../agent'

export type { AgentTool as AnyTool } from '../agent'

/** 工具定义：name + description + zod 参数 + handler（handler 入参类型由 parameters 推导）；失败直接 throw */
export function defineTool<T>(name: string, definition: Omit<AgentTool<T>, 'name'>): AgentTool {
  return { name, ...definition }
}

/** 主机 id schema：所有工具的 hostId 唯一合法来源约定 */
export const hostIdSchema = z.string().describe('Host id, from the id field returned by list_hosts')

/** 工具调用意图描述（模型填写；渲染层工具卡第二行展示，同 execute 的 description 约定） */
export const intentSchema = z
  .string()
  .optional()
  .describe(
    'One-line intent of this operation, written in the same language the user writes in (shown to the user)'
  )

/**
 * 确保主机已连接（未连接时按保存配置自动建连，幂等；连接中则等待就绪）。
 * 连接不存在 / manual 认证待补凭据 / 建连失败时抛错。
 */
export async function ensureLink(hostId: string): Promise<HostLink> {
  const conn = listConnections().find((c) => c.id === hostId)
  if (!conn) {
    throw new Error(
      `Connection not found: ${hostId}. hostId must be the id field returned by list_hosts — call list_hosts first.`
    )
  }
  const link = getOrCreateAgentLink(conn)
  if (link.awaitingCredentials) {
    throw new Error(
      `Host ${conn.name} uses manual auth and is waiting for credentials (enter them in the app first)`
    )
  }
  link.start()
  await link.waitForActive()
  return link
}

/** 取主机 SFTP 会话；未连接时自动建连 */
export async function sftpOf(hostId: string): Promise<HostLink['sftp']> {
  return (await ensureLink(hostId)).sftp
}

/** 取活动 SSH 客户端；未连接时自动建连 */
export async function activeClientOf(hostId: string): Promise<Client> {
  const client = (await ensureLink(hostId)).activeClient
  if (!client) throw new Error(`Host not connected: ${hostId}`)
  return client
}
