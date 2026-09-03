import { agentConnectionContext } from '../agentLinks'
import { setExecutionClientResolver } from '../exec'
import { executeTools } from './execute'
import { computeTools } from './compute'
import { activeClientOf, type AnyTool } from './shared'
import { connectionTools } from './connection'
import { sftpTools } from './sftp'
import { transferTools } from './transfer'
import { manageTools } from './manage'
import { noteTools } from './note'

// execute 的远程命令经活动 SSH 客户端执行（解析器来自连接域的自动建连助手）
setExecutionClientResolver(activeClientOf)

/** handler 在会话级链路上下文内执行（自动建连归属到发起会话）；异常由 SDK 结算为 tool-error 回传模型与 UI */
function withSessionContext(tool: AnyTool): AnyTool {
  return {
    ...tool,
    handler: (args, invocation) =>
      agentConnectionContext.run(invocation.sessionId, () => tool.handler(args, invocation))
  }
}

/* ---------------- 并发策略（资源锁键） ---------------- */

type LockKeyFn = (input: Record<string, unknown>) => string | null

/** 直行（无锁）：不碰主机链路、不写本机数据 —— 只读元信息、纯计算、独立拨号 */
const none: LockKeyFn = () => null
/** 按主机串行：需要主机链路或远端文件系统的操作（含只读，避免与 connect 的拆链重拨竞态） */
const host: LockKeyFn = (input) =>
  typeof input.hostId === 'string' && input.hostId ? `host:${input.hostId}` : null
/** 本机连接/分组/备注数据写入（同步原子，串行只为可预期的顺序，不排队于远端 IO） */
const store: LockKeyFn = () => 'store'

/**
 * 每个工具的资源锁键。同键调用在本会话内按 tool call / 卡片顺序 FIFO，不同键与无键并行。
 * Record<AiToolName, ...> 即穷尽性检查：新增工具必须在此明确其并发归属。
 */
const LOCK_KEYS: Record<AiToolName, LockKeyFn> = {
  list_hosts: none,
  list_connections: none,
  list_groups: none,
  probe_latency: none,
  test_connection: none,
  write_temp_file: none,
  compute: none,
  connect: host,
  connect_via: host,
  disconnect: host,
  delete_connection: host,
  sftp_list: host,
  sftp_read: host,
  sftp_stat: host,
  sftp_write: host,
  sftp_patch: host,
  sftp_delete: host,
  sftp_mkdir: host,
  sftp_rename: host,
  sftp_download: host,
  sftp_upload: host,
  add_connection: store,
  edit_connection: store,
  add_group: store,
  rename_group: store,
  delete_group: store,
  edit_note: store,
  // 同一条后台 shell 的输入与游标必须严格有序；start/list 不占锁（各自开新通道 / 只读列表）
  execute: (input) =>
    input.action === 'start' || input.action === 'list'
      ? null
      : `exec:${String(input.executionId ?? '')}`
}

/** 给工具挂上资源锁键（策略集中在 LOCK_KEYS，工具实现不感知并发） */
function withLockKey(tool: AnyTool): AnyTool {
  return { ...tool, lockKey: (input) => LOCK_KEYS[tool.name as AiToolName](input ?? {}) }
}

export const aiTools: AnyTool[] = [
  ...connectionTools,
  ...sftpTools,
  ...executeTools,
  ...computeTools,
  ...transferTools,
  ...manageTools,
  ...noteTools
]
  .map(withSessionContext)
  .map(withLockKey)

export type AiToolName =
  | 'list_hosts'
  | 'list_connections'
  | 'connect'
  | 'connect_via'
  | 'disconnect'
  | 'sftp_list'
  | 'sftp_read'
  | 'sftp_write'
  | 'sftp_patch'
  | 'sftp_delete'
  | 'sftp_mkdir'
  | 'sftp_rename'
  | 'sftp_stat'
  | 'sftp_download'
  | 'sftp_upload'
  | 'execute'
  | 'add_connection'
  | 'edit_connection'
  | 'delete_connection'
  | 'test_connection'
  | 'probe_latency'
  | 'add_group'
  | 'list_groups'
  | 'rename_group'
  | 'delete_group'
  | 'edit_note'
  | 'write_temp_file'
  | 'compute'
