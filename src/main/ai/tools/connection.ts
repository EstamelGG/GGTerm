import { z } from 'zod'
import { defineTool } from './shared'
import { listConnections, listGroups } from '../../data/connections'
import { groupChain } from '../../../shared/groupTree'
import type { HostLinkSnapshot, LinkPhase } from '../../../shared/types'
import { getLink, listLinks } from '../../ssh/link'
import {
  getAgentLink,
  getOrCreateAgentLink,
  listAgentConnections,
  disconnectAgentLink as disconnectLink
} from '../agentLinks'
import { hostIdSchema, intentSchema, type AnyTool } from './shared'

/** 请求路由与实际路由是否一致（顺序敏感；undefined 视为直连 []） */
function sameRoute(actual: string[] | undefined, requested: string[]): boolean {
  const a = actual ?? []
  return a.length === requested.length && a.every((id, i) => id === requested[i])
}

/** 链路相位口径：已建立（TCP + SSH 握手完成，对照 HostLink.isActive）/ 拨号中（含自动重连） */
const isUp = (phase: LinkPhase): boolean => phase === 'connected'
const isDialing = (phase: LinkPhase): boolean => phase === 'connecting' || phase === 'reconnecting'

/** list_connections 的行：一条真实 SSH 传输（≠ 保存的连接；同一主机可同时有 user 与 agent 两条） */
interface ConnectionRow {
  connectionId: string
  owner: 'user' | 'agent'
  /** 属于本 AI 对话（仅 agent 侧可能为 true；disconnect 只影响这些） */
  mine: boolean
  hostId: string
  name: string
  address: string
  phase: LinkPhase
  since: number
  attempt: number | null
  reason: string | null
  /** 实际使用的跳板链（不含目标；空数组 = 直连） */
  jumpChain: { hostId: string; name: string }[]
  /** 挂在该传输上的会话数（user = 应用窗口的终端数；agent = 该对话在该主机上运行中的执行数） */
  shells: number
}

/** 连接生命周期域：寻址/预连/临时跳板/断开 */
export const connectionTools: AnyTool[] = [
  defineTool('list_hosts', {
    description:
      'List all saved SSH connections (online status, group path, live connection counts, duplicate flag; no credentials). connections = SSH transports currently established to this host, split by owner: user (this app window) and agent (AI conversations — each conversation holds its own transport); connections.total = user + agent, connections.pending = links still dialing/reconnecting (not established yet). This is the per-host rollup only — for the individual transports (one entry per real connection, with its connectionId and jump chain) use list_connections. The id field in the result is the only valid source of hostId for connect/execute/sftp_* etc. — when the user mentions a host by name/IP, call this tool first to resolve it. groupPath is the directory chain of the host in the connection list (root first). Set includeNote=true only when the note content (purpose/containers/ports etc.) is actually needed.',
    parameters: z.object({
      description: intentSchema,
      includeNote: z
        .boolean()
        .optional()
        .describe(
          'Include the host note field in the result (off by default; only request when the note content is needed)'
        )
    }),
    handler: async ({ includeNote }) => {
      const groups = listGroups()
      const conns = listConnections()
      // 重复标签：host + port + username 完全一致即视为可疑重复，整组打标
      const dupKey = (c: { host: string; port: number; username: string }): string =>
        `${c.host}\u0000${c.port}\u0000${c.username}`
      const countByKey = new Map<string, number>()
      for (const c of conns) countByKey.set(dupKey(c), (countByKey.get(dupKey(c)) ?? 0) + 1)
      // 在册链路按主机归集：用户侧每主机最多一条（应用界面链路），agent 侧每个 AI 会话各一条独占链路
      const agentPhases = new Map<string, LinkPhase[]>()
      for (const item of listAgentConnections()) {
        const list = agentPhases.get(item.hostId)
        if (list) list.push(item.phase)
        else agentPhases.set(item.hostId, [item.phase])
      }
      return conns.map((c) => {
        const link = getAgentLink(c.id)
        const userPhase = getLink(c.id)?.phase ?? 'idle'
        const agentCount = (agentPhases.get(c.id) ?? []).filter(isUp).length
        const userCount = isUp(userPhase) ? 1 : 0
        const base = {
          id: c.id,
          name: c.name,
          host: c.host,
          port: c.port,
          username: c.username,
          jumpHostIds: c.jumpHostIds ?? [],
          // 所在目录链（根在前，含所在目录；未分组为空数组）
          groupPath: c.groupId ? groupChain(c.groupId, groups).map((g) => g.name) : [],
          connected: link?.isActive ?? false,
          phase: link?.phase ?? 'idle',
          // 当前建立的连接数（含其他 AI 会话，不限于本会话）
          connections: {
            total: userCount + agentCount,
            user: userCount,
            agent: agentCount,
            pending:
              (isDialing(userPhase) ? 1 : 0) +
              (agentPhases.get(c.id) ?? []).filter(isDialing).length
          },
          duplicate: (countByKey.get(dupKey(c)) ?? 0) > 1
        }
        return includeNote ? { ...base, note: c.note ?? null } : base
      })
    }
  }),
  defineTool('list_connections', {
    description:
      'List the SSH transports that exist right now — one entry per real connection, not per saved host. owner=user is this app window (at most one transport per host); owner=agent is an AI conversation, and each conversation keeps its own transport, so 3 conversations on the same host show as 3 entries. Each entry carries connectionId, the target hostId, jumpChain = the jump chain actually in use (empty = direct) and shells = sessions riding on it (user: terminal tabs of the app window; agent: running executions of that conversation on the host). mine=true marks the transports owned by this AI conversation (disconnect only affects those). Only transports that currently exist are listed (connecting / reconnecting / connected) — a host that was never connected, or already fully disconnected, does not appear; use list_hosts for saved config, per-host status and offline reasons.',
    parameters: z.object({ description: intentSchema }),
    handler: async (_args, invocation) => {
      const saved = new Map(listConnections().map((c) => [c.id, c]))
      // 名称退化顺序与拓扑图一致：用户设置的显示名 → 主机地址 → id 前缀（跳板可能已从列表删除）
      const nameOf = (id: string): string => {
        const conn = saved.get(id)
        return conn?.name || conn?.host || id.slice(0, 8)
      }
      /** 只在「确实存在一条传输」时入列：拨号中/重连中/已建立；idle/offline 没有传输 */
      const isLive = (phase: LinkPhase): boolean =>
        phase === 'connected' || phase === 'connecting' || phase === 'reconnecting'
      const row = (
        s: HostLinkSnapshot,
        owner: 'user' | 'agent',
        mine: boolean,
        connectionId: string,
        shells: number
      ): ConnectionRow => {
        const conn = saved.get(s.hostId)
        return {
          connectionId,
          owner,
          mine,
          hostId: s.hostId,
          name: nameOf(s.hostId),
          address: conn ? `${conn.username}@${conn.host}:${conn.port}` : '',
          phase: s.phase,
          since: s.since,
          attempt: s.attempt ?? null,
          reason: s.reason ?? null,
          jumpChain: (s.jumpIds ?? []).map((id) => ({ hostId: id, name: nameOf(id) })),
          shells
        }
      }
      const rows = [
        // 应用窗口链路：每主机至多一条；shells = 挂在该链路上的终端标签数
        ...listLinks()
          .filter((s) => isLive(s.phase))
          .map((s) => {
            const link = getLink(s.hostId)
            return row(s, 'user', false, link?.connectionId ?? '', link?.shells.size ?? 0)
          }),
        // AI 会话链路：每会话一条独占传输（含其他会话）；shells = 该会话在该主机上运行中的执行数
        ...listAgentConnections()
          .filter((s) => isLive(s.phase))
          .map((s) =>
            row(s, 'agent', s.sessionId === invocation.sessionId, s.connectionId, s.shellCount ?? 0)
          )
      ]
      // 同一主机可能两侧各有一条：按主机名归组、组内 owner 定序，输出稳定
      return rows.sort((a, b) => a.name.localeCompare(b.name) || a.owner.localeCompare(b.owner))
    }
  }),
  defineTool('connect', {
    description:
      'Explicitly establish an SSH connection to a host (routed per its saved config). Reuses an existing connection if already on the saved route; if the actual route differs (e.g. a temporary jump host from a previous connect_via), it tears down and reconnects per the saved config. Other tools auto-connect when needed — use this only for pre-warming or switching back to the saved route.',
    parameters: z.object({ description: intentSchema, hostId: hostIdSchema }),
    handler: async ({ hostId }) => {
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
      // 显式 connect = 回归保存配置路由：清临时跳板，实际路由与保存配置不符（或未连接）即重拨
      link.setJumpOverride(null)
      if (!link.isActive || !sameRoute(link.effectiveJumpIds, conn.jumpHostIds ?? [])) {
        link.restart()
      }
      await link.waitForActive()
      return {
        hostId,
        host: conn.host,
        port: conn.port,
        connectionId: link.connectionId,
        phase: link.phase,
        awaiting: link.awaitingCredentials
      }
    }
  }),
  defineTool('connect_via', {
    description:
      'Connect to a target host via a jump host (temporary route; does not modify the saved config of the target). Use when the target is unreachable directly but reachable from some saved host. Reuses an existing connection if already on that jump route; if the actual route differs (direct or via another jump), it tears down and reconnects via the given jump. The temporary route persists for this run (auto-reconnects keep it) and reverts to the saved config after an app restart. The jump host must be saved and not manual-auth; the target uses its own saved credentials.',
    parameters: z.object({
      description: intentSchema,
      hostId: hostIdSchema.describe('Target host id'),
      viaHostId: hostIdSchema.describe('Jump host id (must not be the target itself)')
    }),
    handler: async ({ hostId, viaHostId }) => {
      const conn = listConnections().find((c) => c.id === hostId)
      if (!conn) throw new Error(`Connection not found: ${hostId}`)
      const via = listConnections().find((c) => c.id === viaHostId)
      if (!via) throw new Error(`Jump host not found: ${viaHostId}`)
      if (viaHostId === hostId) throw new Error('The jump host must not be the target itself')
      if (via.authType === 'manual')
        throw new Error(`Jump host "${via.name}" uses manual auth and cannot serve as a jump`)
      const link = getOrCreateAgentLink(conn)
      if (link.awaitingCredentials)
        throw new Error(
          `Host ${conn.name} uses manual auth and is waiting for credentials (enter them in the app first)`
        )
      // 显式指定路由：实际路由与 [viaHostId] 不符（直连/经其他跳板/未连接）即拆链重拨
      link.setJumpOverride([viaHostId])
      if (!link.isActive || !sameRoute(link.effectiveJumpIds, [viaHostId])) {
        link.restart()
      }
      await link.waitForActive()
      return {
        hostId,
        host: conn.host,
        port: conn.port,
        connectionId: link.connectionId,
        viaHostId,
        phase: link.phase,
        routedVia: via.name
      }
    }
  }),
  defineTool('disconnect', {
    description:
      'Disconnect this AI conversation from a host (its dedicated SSH connection and executions), without affecting the user or other AI conversations. Call list_connections afterwards to confirm the transport is gone — one call covers every host disconnected in the batch.',
    parameters: z.object({ description: intentSchema, hostId: hostIdSchema }),
    handler: async ({ hostId }) => {
      disconnectLink(hostId)
      return { hostId, disconnected: true }
    }
  })
]
