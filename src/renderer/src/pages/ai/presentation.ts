import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import type { TFunction } from 'i18next'
import type { LucideIcon } from 'lucide-react'
import {
  Calculator,
  Download,
  FileDiff,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Gauge,
  HeartPulse,
  Layers,
  Monitor,
  NotebookPen,
  Pen,
  Plug,
  Plus,
  Replace,
  Search,
  Server,
  ServerCog,
  ServerOff,
  SquareTerminal,
  Trash2,
  Unplug,
  Upload,
  Waypoints
} from 'lucide-react'

/** 工具块（SDK ToolUIPart：状态机 input-* / approval-* / output-*） */
export type ToolPart = ToolUIPart | DynamicToolUIPart

/** 折叠态单行 JSON（兜底摘要用） */
function compactJson(v: unknown, max = 300): string {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v))
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 主机显示名解析：`name (ip)`，查不到回退原始 id */
export type HostResolver = (hostId: string) => string

/** 工具卡图标映射（与 main/ai/tools 的 35 个工具一一对应），未知工具兜底 Wrench */
export const TOOL_ICONS: Record<string, LucideIcon> = {
  list_port_forwards: Waypoints,
  configure_port_forward: Plug,
  control_port_forward: Plug,
  probe_port_forward: Gauge,
  list_hosts: Server,
  list_connections: Waypoints,
  connect: Plug,
  connect_via: Waypoints,
  disconnect: Unplug,
  sftp_list: FolderOpen,
  sftp_read: FileText,
  sftp_stat: FileSearch,
  sftp_write: FilePen,
  sftp_patch: FileDiff,
  sftp_delete: Trash2,
  sftp_mkdir: FolderPlus,
  sftp_rename: Replace,
  sftp_download: Download,
  sftp_upload: Upload,
  write_temp_file: FilePlus,
  execute: SquareTerminal,
  add_connection: Plus,
  edit_connection: ServerCog,
  delete_connection: ServerOff,
  test_connection: HeartPulse,
  probe_latency: Gauge,
  add_group: Layers,
  list_groups: Layers,
  rename_group: Pen,
  delete_group: FolderMinus,
  edit_note: NotebookPen,
  compute: Calculator,
  // 本机域：命令执行与文件读写/检索（本地无 hostId，靠图标与摘要区分）
  local_exec: Monitor,
  local_list: FolderOpen,
  local_stat: FileSearch,
  local_read: FileText,
  local_write: FilePen,
  local_patch: FileDiff,
  local_grep: Search
}

export const strOf = (o: unknown, k: string): string => {
  const v = typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[k] : undefined
  return typeof v === 'string' ? v : ''
}

/** 按工具生成「动作：关键参数」摘要；未知工具回退紧凑 JSON（空入参返回空串不渲染） */
export function toolSummary(
  name: string,
  input: unknown,
  output: unknown,
  host: HostResolver,
  t: TFunction
): string {
  if (typeof input !== 'object' || input === null) return compactJson(input)
  const o = input as Record<string, unknown>
  const str = (k: string): string => strOf(o, k)
  const outStr = (k: string): string => strOf(output, k)
  switch (name) {
    case 'execute': {
      const action = str('action')
      if (action === 'start' || action === 'command') {
        const command = str('command')
        return command ? t('ai.tool.execute', { command }) : t('ai.tool.executeShell')
      }
      if (action === 'input') return t('ai.tool.executeInput', { input: str('input') })
      if (action === 'cancel') return t('ai.tool.executeCancel')
      if (action === 'list') return t('ai.tool.executeList')
      return t('ai.tool.executePoll')
    }
    case 'list_hosts':
      return t('ai.tool.listConnections')
    case 'list_connections':
      return t('ai.tool.listLiveConnections')
    case 'connect':
      return t('ai.tool.connect', { host: host(str('hostId')) })
    case 'connect_via':
      return t('ai.tool.connectVia', { via: host(str('viaHostId')), host: host(str('hostId')) })
    case 'disconnect':
      return t('ai.tool.disconnect', { host: host(str('hostId')) })
    case 'sftp_list':
      return t('ai.tool.sftpList', { path: str('path') })
    case 'sftp_read':
      return t('ai.tool.sftpRead', { path: str('path') })
    case 'sftp_write':
      return t('ai.tool.sftpWrite', { path: str('path') })
    case 'sftp_patch':
      return t('ai.tool.sftpPatch', { path: str('path') })
    case 'sftp_delete':
      return t('ai.tool.sftpDelete', { path: str('path') })
    case 'sftp_mkdir':
      return t('ai.tool.sftpMkdir', { path: str('path') })
    case 'sftp_rename':
      return t('ai.tool.sftpRename', { src: str('src'), dest: str('dest') })
    case 'sftp_stat':
      return t('ai.tool.sftpStat', { path: str('path') })
    // 目的路径补全为完整落点（destDir 拼文件名，缺省目录与 engine.ts 审批逻辑一致）
    case 'sftp_download': {
      const src = str('path')
      const base =
        src
          .split(/[\\/]+/)
          .filter(Boolean)
          .pop() ?? ''
      const destDir = str('destDir').trim().replace(/\/+$/, '')
      const dest =
        outStr('localPath') ||
        (destDir && base ? `${destDir}/${base}` : '') ||
        t('ai.tool.destDownloads')
      return [t('ai.tool.sourcePath', { path: src }), t('ai.tool.destPath', { path: dest })].join(
        '\n'
      )
    }
    case 'sftp_upload': {
      const src = str('localPath')
      const base =
        src
          .split(/[\\/]+/)
          .filter(Boolean)
          .pop() ?? ''
      const destDir = str('destDir').trim().replace(/\/+$/, '')
      const dest = outStr('destPath') || `~/${destDir ? `${destDir}/` : ''}${base}`
      return [t('ai.tool.sourcePath', { path: src }), t('ai.tool.destPath', { path: dest })].join(
        '\n'
      )
    }
    case 'add_connection':
      return t('ai.tool.addConnection', {
        name: str('name'),
        detail: `${str('username')}@${str('host')}`
      })
    case 'edit_connection':
      return t('ai.tool.editConnection', { name: str('name') || host(str('hostId')) })
    case 'delete_connection':
      return t('ai.tool.deleteConnection', { host: host(str('hostId')) })
    case 'test_connection':
      return t('ai.tool.testConnection', { host: host(str('hostId')) })
    case 'probe_latency':
      return t('ai.tool.probeLatency', { host: host(str('hostId')) })
    case 'add_group':
      return t('ai.tool.addGroup', { name: str('name') })
    case 'list_groups':
      return t('ai.tool.listGroups')
    case 'rename_group':
      return t('ai.tool.renameGroup', { name: str('name') })
    case 'delete_group':
      return t('ai.tool.deleteGroup', { name: str('name') })
    case 'edit_note':
      return t('ai.tool.editNote', { host: host(str('hostId')) })
    case 'write_temp_file':
      return t('ai.tool.writeTempFile', { name: str('name') || t('ai.tool.autoName') })
    case 'compute': {
      const action = str('action')
      if (action === 'hash')
        return t('ai.tool.computeHash', { algo: str('algo'), data: str('data') })
      if (action === 'base_convert')
        return t('ai.tool.computeBaseConvert', {
          value: str('value'),
          from: String(o.fromBase ?? ''),
          to: String(o.toBase ?? '')
        })
      return t('ai.tool.computeCodec', { action, op: str('op'), data: str('data') })
    }
    // 本机域：摘要统一带 path（缺省即家目录）；命令与正则各显示关键参数
    case 'local_exec':
      return t('ai.tool.localExec', { command: str('command') })
    case 'local_list':
      return t('ai.tool.localList', { path: str('path') || '~' })
    case 'local_stat':
      return t('ai.tool.localStat', { path: str('path') })
    case 'local_read':
      return t('ai.tool.localRead', { path: str('path') })
    case 'local_write':
      return t('ai.tool.localWrite', { path: str('path') })
    case 'local_patch':
      return t('ai.tool.localPatch', { path: str('path') })
    case 'local_grep':
      return t('ai.tool.localGrep', { path: str('path') || '~', pattern: str('pattern') })
    default:
      return Object.keys(o).length ? compactJson(input) : ''
  }
}

/** 响应分页显示：初始行数与每次「显示更多」追加行数 */
export const RESPONSE_PAGE = 10

/** 字节数 human-readable（卡片目录列表用） */
function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

/**
 * 展开区响应提取（完整文本，渲染层分页显示）：execute=命令输出、sftp_list=条目列表、
 * sftp_read=文件内容、probe_latency=结论摘要、list_hosts/list_connections/list_groups=清单、
 * test_connection/sftp_stat=一行结论；工具成功但输出为空时显示「空」占位（区分「没跑」和「跑了没结果」）；
 * 连接/写入/传输等确认型工具不设响应区（无信息量）
 */
export function responseOf(name: string, output: unknown, t: TFunction): string | null {
  if (name === 'sftp_list' || name === 'local_list') {
    if (!Array.isArray(output)) return null
    const lines = output
      .map((e) => {
        const item = e as { name?: unknown; isDir?: unknown; size?: unknown; isLink?: unknown }
        const n = typeof item.name === 'string' ? item.name : ''
        if (!n) return ''
        // 目录带 / 后缀（不显示无意义的块大小）；符号链接带 @ 后缀；文件显示 human-readable 大小
        if (item.isDir === true) return `${n}/`
        const suffix = item.isLink === true ? '@' : ''
        const size = typeof item.size === 'number' ? formatSize(item.size) : '?'
        return `${n}${suffix}  ${size}`
      })
      .filter(Boolean)
    return lines.length ? lines.join('\n') : t('ai.tool.toolNoOutput')
  }
  if (name === 'list_hosts') {
    if (!Array.isArray(output)) return null
    const lines = output
      .map((e) => {
        const it = e as {
          name?: unknown
          host?: unknown
          port?: unknown
          username?: unknown
          groupPath?: unknown
          connections?: unknown
        }
        if (typeof it.name !== 'string' || !it.name) return ''
        const user = typeof it.username === 'string' ? it.username : ''
        const host = typeof it.host === 'string' ? it.host : ''
        // 22 为默认端口，省略不显示
        const port = typeof it.port === 'number' && it.port !== 22 ? `:${it.port}` : ''
        const group =
          Array.isArray(it.groupPath) && it.groupPath.length ? `  ${it.groupPath.join('/')}` : ''
        // 连接数：已建立（●）拆成用户侧（应用界面）与 agent 侧（各 AI 会话，每会话一条）；
        // 仅有拨号/重连中的链路时显示 ○，与「从未连接」区分
        const conns = it.connections as
          { total?: unknown; user?: unknown; agent?: unknown; pending?: unknown } | undefined
        const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
        const total = num(conns?.total)
        const state = total
          ? `  ● ${t('ai.tool.connUser', { n: num(conns?.user) })} · ${t('ai.tool.connAgent', { n: num(conns?.agent) })}`
          : num(conns?.pending)
            ? `  ○ ${t('ai.tool.connDialing')}`
            : ''
        return `${it.name}  ${user}@${host}${port}${group}${state}`
      })
      .filter(Boolean)
    return lines.length ? lines.join('\n') : t('ai.tool.toolNoOutput')
  }
  if (name === 'list_connections') {
    if (!Array.isArray(output)) return null
    const lines = output
      .map((e) => {
        const it = e as {
          owner?: unknown
          mine?: unknown
          address?: unknown
          jumpChain?: unknown
          shells?: unknown
        }
        const address = typeof it.address === 'string' ? it.address : ''
        if (!address) return ''
        // 归属：用户侧 = 应用界面链路；agent 侧再分「本对话 / 其他对话」（disconnect 只影响本对话）
        const owner =
          it.owner === 'agent'
            ? t(it.mine === true ? 'ai.tool.connOwnerAgentSelf' : 'ai.tool.connOwnerAgent')
            : t('ai.tool.connOwnerUser')
        const chain = Array.isArray(it.jumpChain)
          ? it.jumpChain
              .map((h) => strOf(h, 'name'))
              .filter(Boolean)
              .join(' > ')
          : ''
        const via = chain ? `  ${t('ai.tool.connVia', { chain })}` : ''
        const shells =
          typeof it.shells === 'number' && it.shells > 0
            ? `  ${t('ai.tool.connShells', { n: it.shells })}`
            : ''
        return `${owner}  ${address}${via}${shells}`
      })
      .filter(Boolean)
    return lines.length ? lines.join('\n') : t('ai.tool.toolNoOutput')
  }
  if (name === 'list_groups') {
    if (!Array.isArray(output)) return null
    const lines = output
      .map((e) => {
        const p = (e as { groupPath?: unknown }).groupPath
        return Array.isArray(p) ? p.filter((x) => typeof x === 'string').join('/') : ''
      })
      .filter(Boolean)
    return lines.length ? lines.join('\n') : t('ai.tool.toolNoOutput')
  }
  if (typeof output !== 'object' || output === null) return null
  const o = output as Record<string, unknown>
  switch (name) {
    case 'execute':
      if (typeof o.output !== 'string') return null
      return o.output.trim() ? o.output.replace(/\s+$/, '') : t('ai.tool.toolNoOutput')
    case 'sftp_read':
      return readResponse(o, t)
    case 'probe_latency':
      return typeof o.summary === 'string' && o.summary.trim() ? o.summary : null
    case 'test_connection':
      return o.ok === true && typeof o.durationMs === 'number' ? `ok · ${o.durationMs}ms` : null
    case 'sftp_stat': {
      const size = o.isDir === true ? 'dir' : typeof o.size === 'number' ? formatSize(o.size) : ''
      const mtime = typeof o.modified === 'number' ? new Date(o.modified).toLocaleString() : ''
      return [size, mtime].filter(Boolean).join(' · ') || null
    }
    case 'compute':
      if (typeof o.digest === 'string' && o.digest) return o.digest
      if (typeof o.result === 'string' && o.result) return o.result
      return null
    // 本机：命令（超时/非零退出码作为首行提示）+ 文件内容 / 元数据 / 检索命中
    case 'local_exec': {
      if (typeof o.output !== 'string') return null
      const code = typeof o.exitCode === 'number' ? o.exitCode : null
      const status =
        o.timedOut === true
          ? t('ai.tool.execTimeout')
          : code !== null && code !== 0
            ? t('ai.tool.exitCode', { code: String(code) })
            : ''
      const body = o.output.trim() ? o.output.replace(/\s+$/, '') : t('ai.tool.toolNoOutput')
      return status ? `${status}\n\n${body}` : body
    }
    case 'local_read':
      return readResponse(o, t)
    case 'local_stat': {
      const kind = o.isDir === true ? 'dir' : o.isLink === true ? 'link' : 'file'
      const mode = typeof o.mode === 'string' ? o.mode : ''
      const size = typeof o.size === 'number' ? formatSize(o.size) : ''
      const mtime = typeof o.modified === 'number' ? new Date(o.modified).toLocaleString() : ''
      return [kind, mode, size, mtime].filter(Boolean).join(' · ') || null
    }
    case 'local_grep': {
      if (!Array.isArray(o.matches)) return null
      const body = o.matches
        .map((m) => {
          const hit = m as { path?: unknown; line?: unknown; text?: unknown }
          if (typeof hit.path !== 'string' || !hit.path) return ''
          const line = typeof hit.line === 'number' ? hit.line : 0
          const text = typeof hit.text === 'string' ? hit.text : ''
          return `${hit.path}:${line}  ${text}`
        })
        .filter(Boolean)
        .join('\n')
      if (!body) return t('ai.tool.toolNoOutput')
      return o.truncated === true ? `${body}\n${t('ai.tool.truncatedNote')}` : body
    }
    default:
      return null
  }
}

/** 文本类读取结果的响应区：内容 + 分页提示（被截断时说明还有后续、从哪一行续读） */
function readResponse(o: Record<string, unknown>, t: TFunction): string | null {
  if (typeof o.content !== 'string') return null
  const body = o.content.trim() ? o.content.replace(/\s+$/, '') : t('ai.tool.toolNoOutput')
  if (o.truncated !== true) return body
  return `${body}\n${t('ai.tool.readPaged', {
    from: String(o.fromLine ?? ''),
    to: String(o.toLine ?? ''),
    total: String(o.totalLines ?? '')
  })}`
}
