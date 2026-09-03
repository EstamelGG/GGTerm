import { z } from 'zod'
import { defineTool } from './shared'
import {
  createConnection,
  deleteConnection,
  listConnections,
  updateConnection
} from '../../data/connections'
import { deleteSecrets, loadSecrets, saveSecrets } from '../../data/secrets'
import { sshTest } from '../../sshTest'
import { removeLink } from '../../ssh/link'
import { listAgentConnections, closeAgentConnection } from '../agentLinks'
import { probeDetail } from '../../probe'
import { hostIdSchema, intentSchema, type AnyTool } from './shared'

/** 连接资产域：连接记录 CRUD、凭据、连通性测试、延迟探测 */
export const manageTools: AnyTool[] = [
  defineTool('add_connection', {
    description:
      'Create a new SSH connection record (credentials may be saved too; nothing auto-connects — call connect when needed). The returned id is the hostId for all other tools.',
    parameters: z.object({
      description: intentSchema,
      name: z.string().describe('Display name of the connection'),
      host: z.string(),
      username: z.string(),
      port: z.number().optional(),
      authType: z.enum(['password', 'privateKey', 'manual']).optional(),
      groupId: z
        .string()
        .optional()
        .describe(
          'Group id (resolve an existing group via list_groups, or create one via add_group)'
        ),
      jumpHostIds: z.array(z.string()).optional().describe('Jump chain (ordered, outermost first)'),
      password: z.string().optional(),
      privateKey: z.string().optional().describe('Private key content (PEM text, not a path)'),
      passphrase: z.string().optional()
    }),
    handler: async (input) => {
      const conn = createConnection({
        name: input.name,
        host: input.host,
        username: input.username,
        port: input.port,
        authType: input.authType,
        groupId: input.groupId ?? null,
        jumpHostIds: input.jumpHostIds
      })
      if (
        input.password !== undefined ||
        input.privateKey !== undefined ||
        input.passphrase !== undefined
      ) {
        saveSecrets(conn.id, {
          password: input.password,
          privateKey: input.privateKey,
          passphrase: input.passphrase
        })
      }
      return {
        id: conn.id,
        name: conn.name,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        groupId: conn.groupId
      }
    }
  }),

  defineTool('edit_connection', {
    description:
      'Edit modifiable fields of a saved SSH connection (only provided fields are updated). Credentials follow the same rule: pass password/privateKey/passphrase to update them, an empty string to clear a field.',
    parameters: z.object({
      description: intentSchema,
      hostId: hostIdSchema,
      name: z.string().optional(),
      host: z.string().optional(),
      port: z.number().optional(),
      username: z.string().optional(),
      authType: z.enum(['password', 'privateKey', 'manual']).optional(),
      groupId: z
        .string()
        .nullable()
        .optional()
        .describe('Group id; null moves the connection to ungrouped'),
      jumpHostIds: z.array(z.string()).optional(),
      password: z.string().optional(),
      privateKey: z.string().optional().describe('Private key content (PEM text, not a path)'),
      passphrase: z.string().optional()
    }),
    handler: async ({ hostId, ...input }) => {
      if (!listConnections().some((c) => c.id === hostId)) {
        throw new Error(`Connection not found: ${hostId}`)
      }
      const { password, privateKey, passphrase, ...patch } = input
      const hasSecrets =
        password !== undefined || privateKey !== undefined || passphrase !== undefined
      if (Object.keys(patch).length === 0 && !hasSecrets) throw new Error('No fields to update')
      const next = Object.keys(patch).length
        ? updateConnection(hostId, patch)!
        : listConnections().find((c) => c.id === hostId)!
      if (hasSecrets) saveSecrets(hostId, { password, privateKey, passphrase })
      return {
        id: next.id,
        name: next.name,
        host: next.host,
        port: next.port,
        username: next.username
      }
    }
  }),

  defineTool('delete_connection', {
    description:
      "Delete an SSH connection record (cascades: tears down links, clears credentials, removes references to this host from other connections' jump chains).",
    parameters: z.object({ description: intentSchema, hostId: hostIdSchema }),
    handler: async ({ hostId }) => {
      if (!listConnections().some((c) => c.id === hostId))
        throw new Error(`Connection not found: ${hostId}`)
      removeLink(hostId)
      for (const item of listAgentConnections()) {
        if (item.hostId === hostId) closeAgentConnection(hostId, item.connectionId)
      }
      deleteSecrets(hostId)
      deleteConnection(hostId)
      return { hostId, deleted: true }
    }
  }),

  defineTool('test_connection', {
    description:
      'Test SSH connectivity with the saved config and credentials (dials the full jump chain; does not create a persistent connection or affect existing links). Returns the target and elapsed time.',
    parameters: z.object({ description: intentSchema, hostId: hostIdSchema }),
    handler: async ({ hostId }) => {
      const conn = listConnections().find((c) => c.id === hostId)
      if (!conn) throw new Error(`Connection not found: ${hostId}`)
      const secrets = loadSecrets(hostId)
      const startedAt = Date.now()
      await sshTest({
        authType: conn.authType,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        connectTimeout: conn.connectTimeout,
        password: secrets.password,
        privateKey: secrets.privateKey,
        passphrase: secrets.passphrase,
        jumpHostIds: conn.jumpHostIds
      })
      return {
        hostId,
        host: conn.host,
        port: conn.port,
        ok: true,
        durationMs: Date.now() - startedAt
      }
    }
  }),

  defineTool('probe_latency', {
    description:
      'TCP latency probe: probes the saved connection address 3 times and reports average latency plus whether the port is open. TCP reachability only — no credentials involved (use test_connection to verify credentials). Layered with test_connection: 1) port/latency via this tool, 2) SSH credentials via test_connection.',
    parameters: z.object({
      description: intentSchema,
      hostId: hostIdSchema,
      port: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .optional()
        .describe('Port to probe; defaults to the connection port')
    }),
    handler: async ({ hostId, port }) => {
      const conn = listConnections().find((c) => c.id === hostId)
      if (!conn) throw new Error(`Connection not found: ${hostId}`)
      const targetPort = port ?? conn.port
      const d = await probeDetail(conn.host, targetPort, 3)
      // 给模型一句结论性文本（结构化字段供程序消费，summary 供快速阅读）
      const summary = d.dnsError
        ? `DNS resolution failed: ${conn.host}`
        : d.reachable
          ? `Port open (${conn.host}:${targetPort}), avg latency ${d.avgMs}ms (${d.minMs}–${d.maxMs}), packet loss ${Math.round(d.lossRate * 100)}%`
          : `Port unreachable (${conn.host}:${targetPort}): TCP connect failed or timed out`
      return {
        hostId,
        host: conn.host,
        port: targetPort,
        portOpen: d.reachable,
        dnsError: d.dnsError,
        avgLatencyMs: d.avgMs,
        minLatencyMs: d.minMs,
        maxLatencyMs: d.maxMs,
        samplesMs: d.samples,
        lossRate: d.lossRate,
        summary
      }
    }
  })
]
