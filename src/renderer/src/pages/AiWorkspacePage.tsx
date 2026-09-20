import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bot,
  Brain,
  Calculator,
  Check,
  CheckCheck,
  ChevronRight,
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
  Lock,
  Loader2,
  NotebookPen,
  Pen,
  Plug,
  Plus,
  Replace,
  Server,
  ServerCog,
  ServerOff,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Square,
  SquareTerminal,
  Trash2,
  Unplug,
  Upload,
  Waypoints,
  Wrench,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { getToolName, isToolUIPart } from 'ai'
import type { DynamicToolUIPart, ReasoningUIPart, ToolUIPart } from 'ai'
import type { AiApprovalLevel, AiUIMessage } from '@shared/types'
import type { HumanInputRequest } from '@shared/execution'
import { errorMessage } from '@shared/error'
import { contextSettingsFor, modelSettingsKey } from '@shared/ai'
import { ContextUsageIndicator } from '@/components/ai/ContextUsageIndicator'
import { cn } from '@/lib/utils'
import { useShallow } from 'zustand/react/shallow'
import { ghostPillCls } from '@/components/form/Buttons'
import { SecretField } from '@/components/form/Secrets'
import { ButtonTooltip } from '@/components/ui/ButtonTooltip'
import { IconButton } from '@/components/ui/IconButton'
import { StateDot } from '@/components/ui/StateDot'
import { Markdown } from '@/components/ai/Markdown'
import { useWorkspaceStore } from '@/stores/workspace'
import { activeCommandToken, activeMention, SLASH_COMMANDS } from '@/lib/aiInput'
import { ExecutionSessionsButton } from '@/components/ai/ExecutionSessionsButton'
import { MarqueeText } from '@/components/chrome/MarqueeText'
import { linkStateColor, solidDot } from '@/lib/linkPhase'
import { useConnectionsStore } from '@/stores/connections'
import { useHumanInputStore } from '@/stores/humanInput'
import { useLinksStore } from '@/stores/links'
import { usePrefsStore } from '@/stores/prefs'
import {
  isBusy,
  pendingApprovals,
  sessionTitle,
  textOf,
  useAiStore,
  type AiSession
} from '@/stores/ai'
import { useSessionStore } from '@/stores/session'
import {
  DOT_TOP_TEXT,
  DOT_TOP_THINKING,
  DOT_TOP_TOOL,
  TEXT_DOT,
  THINKING_DOT,
  TimelineNode,
  toolDotCls
} from './aiTimeline'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

/** 工具块（SDK ToolUIPart：状态机 input-* / approval-* / output-*） */
type ToolPart = ToolUIPart | DynamicToolUIPart

/** 折叠态单行 JSON（兜底摘要用） */
function compactJson(v: unknown, max = 300): string {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v))
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 主机显示名解析：`name (ip)`，查不到回退原始 id */
type HostResolver = (hostId: string) => string

/** 工具卡图标映射（与 main/ai/tools 的 28 个工具一一对应），未知工具兜底 Wrench */
const TOOL_ICONS: Record<string, LucideIcon> = {
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
  compute: Calculator
}

const strOf = (o: unknown, k: string): string => {
  const v = typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[k] : undefined
  return typeof v === 'string' ? v : ''
}

/** 按工具生成「动作：关键参数」摘要；未知工具回退紧凑 JSON（空入参返回空串不渲染） */
function toolSummary(
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
      if (action === 'start') {
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
    default:
      return Object.keys(o).length ? compactJson(input) : ''
  }
}

/** 响应分页显示：初始行数与每次「显示更多」追加行数 */
const RESPONSE_PAGE = 10

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
function responseOf(name: string, output: unknown, t: TFunction): string | null {
  if (name === 'sftp_list') {
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
      if (typeof o.content !== 'string') return null
      return o.content.trim() ? o.content.replace(/\s+$/, '') : t('ai.tool.toolNoOutput')
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
    default:
      return null
  }
}

/** 源/目的路径行：标签淡化，路径可换行复制 */
function PathRow({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const sep = text.search(/[：:]/)
  const label = sep >= 0 ? text.slice(0, sep + 1) : ''
  const path = sep >= 0 ? text.slice(sep + 1).trim() : text
  return (
    <div className={cn('flex items-start gap-1.5', className)}>
      {label && <span className="shrink-0 text-muted">{label}</span>}
      <span className="min-w-0 whitespace-pre-wrap break-all">{path}</span>
    </div>
  )
}

/** 已拒绝：显式 output-denied，或同一流内自动拒绝后 SDK 落定的 approval-responded(approved=false) */
const isDenied = (p: ToolPart): boolean =>
  p.state === 'output-denied' || (p.state === 'approval-responded' && p.approval.approved === false)

/** 工具块的审批通道：人工（含待确认）/ 自动放行 / 自动拦截；无审批记录返回 null */
function approvalKindOf(p: ToolPart): 'manual' | 'auto' | 'auto-deny' | null {
  // 自动审批请求瞬间也会是 approval-requested，但带 isAutomatic——按自动通道显示，避免黄框闪一下
  if (p.state === 'approval-requested' && p.approval?.isAutomatic) return 'auto'
  if (p.state === 'approval-requested') return 'manual'
  if (!p.approval) return null
  if (!p.approval.isAutomatic) return 'manual'
  return isDenied(p) ? 'auto-deny' : 'auto'
}

/** 是否需要人工点批（自动审批不算待批） */
function needsManualApproval(p: ToolPart): boolean {
  return p.state === 'approval-requested' && !p.approval?.isAutomatic
}

/** 工具块错误文案：执行错误 / 拒绝理由（用户拒绝无理由时用「拒绝」） */
function toolErrorOf(p: ToolPart, t: TFunction): string {
  if (p.state === 'output-error') return p.errorText
  if (isDenied(p)) return p.approval?.reason ?? t('ai.approvalDeny')
  return ''
}

/**
 * 人工输入卡片（密码 / 验证码等敏感提示）：排在对话末尾，与 VS Code 的提问卡同位置。
 * 刻意不嵌进历史里的工具卡：同一 executionId 会出现在多张工具卡上（start 的结果、poll/input 的入参），
 * 按 id 嵌入会重复渲染；且处理时用户视线就在末尾。
 * 值只存在于本组件 state，提交后立刻清空 —— 不经模型、不进日志、不落盘。
 */
const HumanInputCard = memo(function HumanInputCard({
  request
}: {
  request: HumanInputRequest
}): React.JSX.Element {
  const { t } = useTranslation()
  const conn = useConnectionsStore((s) => s.connections.find((c) => c.id === request.hostId))
  /** 待提交的敏感值：本组件 state → 一次 IPC → PTY，不落任何持久层 */
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const hostLabel = conn ? `${conn.name} (${conn.host})` : request.hostId

  const submit = (): void => {
    if (secret.trim() === '') return
    setError('')
    void window.aterm.humanInput
      .submit(request.sessionId, request.executionId, secret)
      .then(() => setSecret(''))
      .catch((err: unknown) => {
        setSecret('')
        setError(errorMessage(err))
      })
  }
  const terminate = (): void => {
    setError('')
    void window.aterm.humanInput
      .cancel(request.sessionId, request.executionId)
      .catch((err: unknown) => setError(errorMessage(err)))
  }

  return (
    <div
      data-input-pending=""
      className="rounded-md border border-warn/40 bg-raised/50 px-2.5 py-2 text-minor"
    >
      {/* 抬头沿用工具卡行式样：状态图标 + 工具名@主机 + 右端状态徽标 */}
      <div className="flex items-center gap-2">
        <Lock size={12} strokeWidth={2.2} className="shrink-0 text-warn" />
        <SquareTerminal size={12} strokeWidth={2.2} className="shrink-0 text-muted" />
        <span className="shrink-0 font-mono text-fg">execute</span>
        <span className="min-w-0 truncate text-caption text-muted">@ {hostLabel}</span>
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 rounded bg-warn/15 px-1 py-0.5 text-caption text-warn">
          {t('ai.inputNeeded')}
        </span>
      </div>
      {request.command && (
        <div className="mt-1 truncate font-mono text-caption text-muted">$ {request.command}</div>
      )}
      {request.prompt && (
        <div className="mt-1.5 select-text overflow-hidden whitespace-pre-wrap break-all rounded border border-line bg-black/25 px-2 py-1 font-mono text-caption text-fg/90">
          {request.prompt}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-2">
        <SecretField
          value={secret}
          onChange={setSecret}
          placeholder={t('ai.inputPlaceholder')}
          className="h-6 min-w-0 flex-1"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            else if (e.key === 'Escape') setSecret('')
          }}
        />
        <button
          type="button"
          disabled={secret.trim() === ''}
          className={cn(
            ghostPillCls,
            'flex h-6 items-center gap-1 bg-ok/40 px-3 text-minor font-medium text-fg hover:bg-ok/50 disabled:opacity-35'
          )}
          onClick={submit}
        >
          <Check size={12} strokeWidth={2.4} className="text-ok brightness-150" />
          {t('ai.inputSubmit')}
        </button>
        <button
          type="button"
          className={cn(
            ghostPillCls,
            'flex h-6 items-center gap-1 px-3 text-minor font-medium text-danger hover:bg-hover'
          )}
          onClick={terminate}
        >
          <X size={12} strokeWidth={2.4} />
          {t('ai.inputTerminate')}
        </button>
      </div>
      {error && <p className="mt-1 text-caption text-danger">{error}</p>}
    </div>
  )
})

/**
 * 工具卡：整行点击展开；标题（状态 / 工具名@主机 / 描述）；
 * queueWaiting = 同一步仍有未批项，SDK 在全部审批响应齐备后才续跑，故已批准者也先显示「等待」。
 */
const ToolCallCard = memo(function ToolCallCard({
  part,
  sessionId,
  queueWaiting = false
}: {
  part: ToolPart
  sessionId: string
  /** 已人工批准，但同一步待批未齐，尚未执行 */
  queueWaiting?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const conns = useConnectionsStore((s) => s.connections)

  const respondApproval = useAiStore((s) => s.respondApproval)
  /** 拒绝两段式：null=未进入备注态；''/文本=待提交（备注可留空） */
  const [rejectNote, setRejectNote] = useState<string | null>(null)
  const name = getToolName(part)
  const hostById: HostResolver = (hostId) => {
    const c = conns.find((x) => x.id === hostId)
    return c ? `${c.name} (${c.host})` : hostId
  }
  // 工具入参里的意图描述（execute 的 description 字段，模型填写；其余工具隐藏第二行）
  const desc = strOf(part.input, 'description')
  // 标题主机：入参/输出 hostId，或 execute 按 executionId 反查会话执行记录
  const directHostId = strOf(part.input, 'hostId') || strOf(part.output, 'hostId')
  const executionId = !directHostId && name === 'execute' ? strOf(part.input, 'executionId') : ''
  const [lookup, setLookup] = useState<{ id: string; hostId: string } | null>(null)
  useEffect(() => {
    if (!executionId) return
    let alive = true
    void window.aterm.executions
      .list(sessionId)
      .then((tasks) => {
        const id = tasks.find((t) => t.executionId === executionId)?.hostId ?? ''
        if (alive) setLookup({ id: executionId, hostId: id })
      })
      .catch(() => {
        if (alive) setLookup({ id: executionId, hostId: '' })
      })
    return () => {
      alive = false
    }
  }, [executionId, sessionId])
  const hostId = directHostId || (lookup?.id === executionId ? lookup.hostId : '')
  const hostLabel = hostId ? hostById(hostId) : null
  const summary = toolSummary(name, part.input, part.output, hostById, t)
  const isTransfer = name === 'sftp_download' || name === 'sftp_upload'
  const response = responseOf(name, part.output, t)
  const downloadLocalPath = name === 'sftp_download' ? strOf(part.output, 'localPath') : ''
  const downloadIsDir = (part.output as { isDir?: unknown } | undefined)?.isDir === true
  const responseLines = response !== null ? response.split('\n') : null
  const [visibleLines, setVisibleLines] = useState(RESPONSE_PAGE)
  const hasMore = responseLines !== null && responseLines.length > visibleLines
  const pending = needsManualApproval(part)
  const error = toolErrorOf(part, t)
  // 人工审批时 main 解析的精确落点（requestReason）优先；否则用 input/output 推导
  const displayPaths = (isTransfer && part.approval?.requestReason) || summary
  const summaryLines = isTransfer ? displayPaths.split('\n') : null
  const [open, setOpen] = useState(false)
  // 标题右侧审批通道标签：人工（含待确认）=黄、自动放行=绿、自动拦截=灰；阻塞等待=信息色
  const kind = approvalKindOf(part)
  const kindBadge = queueWaiting
    ? { label: t('ai.approvalWaiting'), cls: 'bg-info/15 text-info' }
    : !kind
      ? null
      : kind === 'manual'
        ? { label: t('ai.approvalManual'), cls: 'bg-warn/15 text-warn' }
        : kind === 'auto'
          ? { label: t('ai.approvalAuto'), cls: 'bg-ok/15 text-ok' }
          : { label: t('ai.approvalAutoDeny'), cls: 'bg-hover text-muted' }
  const status =
    pending || isDenied(part)
      ? { icon: ShieldAlert, cls: 'text-warn' }
      : queueWaiting
        ? { icon: Loader2, cls: 'text-info animate-spin' }
        : part.state === 'output-available'
          ? { icon: Check, cls: 'text-ok' }
          : part.state === 'output-error'
            ? { icon: X, cls: 'text-danger' }
            : { icon: Loader2, cls: 'text-info animate-spin' }
  const StatusIcon = status.icon
  const ToolIcon = TOOL_ICONS[name] ?? Wrench
  return (
    <div
      data-tool-call-id={part.toolCallId}
      data-approval-pending={pending ? '' : undefined}
      className={cn(
        'rounded-md border bg-raised/50 text-minor',
        pending ? 'border-warn/40' : 'border-line'
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-hover/60"
        onClick={() => setOpen((v) => !v)}
      >
        <StatusIcon size={12} strokeWidth={2.2} className={cn('shrink-0', status.cls)} />
        <span className="block min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <ToolIcon size={12} strokeWidth={2.2} className="shrink-0 text-muted" />
            <span className="min-w-0 truncate font-mono text-fg">{name}</span>
            {hostLabel && (
              <span className="min-w-0 truncate text-caption text-muted">@ {hostLabel}</span>
            )}
          </span>
          {desc && (
            <ButtonTooltip label={desc} delayDuration={1000}>
              <MarqueeText text={desc} className="text-caption text-muted" />
            </ButtonTooltip>
          )}
          {error && !open && (
            <span className="mt-0.5 block truncate text-caption text-danger">{error}</span>
          )}
        </span>
        {kindBadge && (
          <span className={cn('shrink-0 rounded px-1 py-0.5 text-caption', kindBadge.cls)}>
            {kindBadge.label}
          </span>
        )}
        <ChevronRight
          size={12}
          strokeWidth={2.4}
          className={cn(
            'shrink-0 text-muted transition-transform duration-150',
            open && 'rotate-90'
          )}
        />
      </button>
      {open && (displayPaths || response || error) && (
        <div className="border-t border-line/60 px-2.5 py-1.5">
          {displayPaths &&
            (summaryLines ? (
              <div className="select-text font-mono text-caption text-fg/90">
                {summaryLines.map((line, i) =>
                  name === 'sftp_download' && i === 1 ? (
                    <div key={i} className="mt-1 flex items-start gap-1.5">
                      <PathRow text={line} className="min-w-0 flex-1" />
                      {downloadLocalPath && (
                        <IconButton
                          icon={FolderOpen}
                          tone="accent"
                          title={t('ai.tool.openDir')}
                          onClick={() =>
                            void window.aterm.sftp.revealLocal(downloadLocalPath, downloadIsDir)
                          }
                        />
                      )}
                    </div>
                  ) : (
                    <PathRow key={i} text={line} className={i > 0 ? 'mt-1' : ''} />
                  )
                )}
              </div>
            ) : (
              <div className="max-h-40 select-text overflow-y-auto whitespace-pre-wrap break-words font-mono text-caption text-fg/90">
                {displayPaths}
              </div>
            ))}
          {error && (
            <div
              className={cn(
                'select-text whitespace-pre-wrap break-words font-mono text-caption text-danger',
                displayPaths && 'mt-1.5 border-t border-line/60 pt-1.5'
              )}
            >
              {error}
            </div>
          )}
          {!error && response && responseLines && (
            <div className={displayPaths ? 'mt-1.5 border-t border-line/60 pt-1.5' : ''}>
              <div className="mb-0.5 text-caption text-muted">{t('ai.responseTitle')}</div>
              <div className="select-text whitespace-pre-wrap break-words font-mono text-caption text-fg/90">
                {responseLines.slice(0, visibleLines).join('\n')}
              </div>
              {hasMore && (
                <button
                  type="button"
                  onClick={() => setVisibleLines((v) => v + RESPONSE_PAGE)}
                  className="mt-1 cursor-pointer rounded text-caption text-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  {t('ai.showMore')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {needsManualApproval(part) && part.approval && (
        <div className="border-t border-warn/30 px-2.5 py-2">
          {/* 操作参数已在展开区摘要展示，审批区只留操作按钮，避免重复；
              拒绝两段式：先点拒绝（弹备注框），再点提交才生效，备注随拒绝结果回传模型 */}
          <div className="flex gap-2">
            <button
              type="button"
              className={cn(
                ghostPillCls,
                'flex h-6 items-center gap-1 bg-ok/40 px-3 text-minor font-medium text-fg hover:bg-ok/50'
              )}
              onClick={() => {
                setRejectNote(null)
                respondApproval(sessionId, part.approval!.id, true)
              }}
            >
              <Check size={12} strokeWidth={2.4} className="text-ok brightness-150" />
              {t('ai.approvalApprove')}
            </button>
            <button
              type="button"
              className={cn(
                ghostPillCls,
                'flex h-6 items-center gap-1 px-3 text-minor font-medium text-danger hover:bg-hover'
              )}
              onClick={() => {
                if (rejectNote === null) {
                  setRejectNote('')
                  return
                }
                respondApproval(sessionId, part.approval!.id, false, rejectNote.trim() || undefined)
                setRejectNote(null)
              }}
            >
              <X size={12} strokeWidth={2.4} />
              {rejectNote === null ? t('ai.approvalDeny') : t('ai.rejectSubmit')}
            </button>
            {rejectNote !== null && (
              <input
                autoFocus
                value={rejectNote}
                placeholder={t('ai.rejectNotePlaceholder')}
                onChange={(e) => setRejectNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    respondApproval(
                      sessionId,
                      part.approval!.id,
                      false,
                      rejectNote.trim() || undefined
                    )
                    setRejectNote(null)
                  } else if (e.key === 'Escape') {
                    setRejectNote(null)
                  }
                }}
                className="h-6 min-w-0 flex-1 rounded-md border border-line bg-raised px-2 text-caption text-fg placeholder:text-muted/60 outline-none focus:border-at-accent/50"
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
})

/** 思考块：默认折叠；折叠行走马灯滚动显示最新思考内容（尾部预览）；手动展开看全文 */
function ThinkingBlock({ part }: { part: ReasoningUIPart }): React.JSX.Element {
  const { t } = useTranslation()
  const running = part.state === 'streaming'
  const [open, setOpen] = useState(false)
  // 折叠行预览：压平空白后取尾部（最新内容），静态截断展示
  const preview = part.text.replace(/\s+/g, ' ').trim().slice(-160)
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 text-left text-caption text-muted transition-colors hover:text-fg"
        onClick={() => setOpen(!open)}
      >
        {running ? (
          <Loader2 size={11} className="shrink-0 animate-spin" />
        ) : (
          <Brain size={11} className="shrink-0" />
        )}
        <span className="shrink-0">
          {running ? t('ai.thinkingRunning') : t('ai.thinkingTitle')}
        </span>
        {!open && preview ? (
          <span className="min-w-0 flex-1 truncate text-muted/70">{preview}</span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <ChevronRight
          size={11}
          strokeWidth={2.4}
          className={cn('shrink-0 transition-transform duration-150', open && 'rotate-90')}
        />
      </button>
      {open && (
        <div className="mt-1 max-h-40 select-text overflow-y-auto [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Markdown muted>{running ? `${part.text}▍` : part.text}</Markdown>
        </div>
      )}
    </div>
  )
}

/** 用户消息里的 @主机 token 高亮（payload 拼接见 lib/aiInput） */
function highlightMentions(text: string): ReactNode[] {
  return text.split(/(@[^\s@]+)/g).map((seg, i) =>
    seg.startsWith('@') ? (
      <span key={i} className="rounded bg-info/20 px-0.5 text-info">
        {seg}
      </span>
    ) : (
      <span key={i}>{seg}</span>
    )
  )
}

/** 消息时间戳：本机时区；同年省略年份，跨年带年份 */
function formatTimestamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  const date = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  return d.getFullYear() === new Date().getFullYear() ? date : `${d.getFullYear()}-${date}`
}

type Part = AiUIMessage['parts'][number]
/** 可渲染块：思考 / 正文 / 工具（step-start 等结构块不渲染） */
const isRenderable = (p: Part): boolean =>
  p.type === 'text' || p.type === 'reasoning' || isToolUIPart(p)
type PendingToolPart = Extract<ToolPart, { state: 'approval-requested' }>
const isPendingTool = (p: Part): p is PendingToolPart =>
  isToolUIPart(p) && p.state === 'approval-requested' && !p.approval?.isAutomatic

/** 已批准但仍卡在审批态（等前序齐批后续跑） */
const isApprovalHeld = (p: Part): boolean =>
  isToolUIPart(p) && p.state === 'approval-responded' && p.approval.approved === true

/** memo：其他消息/会话级更新时，引用未变化的消息整棵子树跳过重渲染 */
const MessageItem = memo(function MessageItem({
  m,
  sessionId
}: {
  m: AiUIMessage
  sessionId: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const respondApproval = useAiStore((s) => s.respondApproval)
  const createdAt = m.metadata?.createdAt
  const stamp = createdAt ? (
    <span className="text-caption text-muted/70">{formatTimestamp(createdAt)}</span>
  ) : null
  if (m.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
        {stamp}
        {m.metadata?.hostReferences?.map((host) => (
          <span
            key={host.id}
            title={`${host.host}:${host.port}`}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-raised px-2 py-1 text-caption"
          >
            <Server size={12} />
            <span className="truncate">{host.name}</span>
          </span>
        ))}
        <div className="max-w-[85%] select-text break-words rounded-lg bg-at-accent/15 px-3 py-2 text-body text-fg [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Markdown decorator={highlightMentions}>{textOf(m)}</Markdown>
        </div>
      </div>
    )
  }
  // 一个回合 = 一条步骤时间线：思考/正文/工具卡同级挂在轴上、按真实发生顺序排列
  const parts = m.parts.filter(isRenderable)
  const lastIdx = parts.length - 1
  // 同一步仍有人工待批时，已批准的卡显示「等待」（齐批前不会执行）
  const approvalBlocked = parts.some(isPendingTool)
  const renderPart = (p: Part, i: number): ReactNode => {
    const first = i === 0
    const last = i === lastIdx
    if (p.type === 'reasoning')
      return (
        <TimelineNode
          key={i}
          dotCls={THINKING_DOT}
          dotTop={DOT_TOP_THINKING}
          first={first}
          last={last}
        >
          <ThinkingBlock part={p} />
        </TimelineNode>
      )
    if (p.type === 'text') {
      if (!p.text) return null
      return (
        <TimelineNode key={i} dotCls={TEXT_DOT} dotTop={DOT_TOP_TEXT} first={first} last={last}>
          <div className="select-text text-body text-fg">
            <Markdown>{p.state === 'streaming' ? `${p.text}▍` : p.text}</Markdown>
          </div>
        </TimelineNode>
      )
    }
    if (!isToolUIPart(p)) return null
    return (
      <TimelineNode
        key={p.toolCallId}
        dotCls={toolDotCls(p)}
        dotTop={DOT_TOP_TOOL}
        first={first}
        last={last}
      >
        <ToolCallCard
          part={p}
          sessionId={sessionId}
          queueWaiting={approvalBlocked && isApprovalHeld(p)}
        />
      </TimelineNode>
    )
  }
  // 连续 ≥3 张待审批工具卡自动成组：warn 外框放在时间线圆点右侧，底部黄色操作条提供批量出口
  const rendered: ReactNode[] = []
  let i = 0
  while (i < parts.length) {
    if (isPendingTool(parts[i])) {
      let j = i
      while (j < parts.length && isPendingTool(parts[j])) j++
      if (j - i >= 3) {
        const run = parts.slice(i, j).filter(isPendingTool)
        const respondAll = (approved: boolean): void =>
          run.forEach((p) => respondApproval(sessionId, p.approval.id, approved))
        rendered.push(
          <TimelineNode
            key={`approval-group-${i}`}
            dotCls="bg-warn animate-pulse"
            dotTop={DOT_TOP_TOOL}
            first={i === 0}
            last={j - 1 === lastIdx}
          >
            <div className="flex flex-col gap-1.5 rounded-lg border border-warn/40 p-1.5">
              {run.map((p) => (
                <ToolCallCard key={p.toolCallId} part={p} sessionId={sessionId} />
              ))}
              {/* 底部批量操作条：黄色填充；同意在左（绿色双对勾），拒绝在右（红色叉） */}
              <div className="flex items-center justify-end gap-2 rounded-md bg-warn/10 px-2 py-1.5">
                <button
                  type="button"
                  className={cn(
                    ghostPillCls,
                    'flex h-6 items-center gap-1 bg-ok/40 px-3 text-minor font-medium text-fg hover:bg-ok/50'
                  )}
                  onClick={() => respondAll(true)}
                >
                  <CheckCheck size={12} strokeWidth={2.4} className="text-ok brightness-150" />
                  {t('ai.approvalApproveAll')}
                </button>
                <button
                  type="button"
                  className={cn(
                    ghostPillCls,
                    'flex h-6 items-center gap-1 px-3 text-minor font-medium text-danger hover:bg-hover'
                  )}
                  onClick={() => respondAll(false)}
                >
                  <X size={12} strokeWidth={2.4} />
                  {t('ai.approvalDenyAll')}
                </button>
              </div>
            </div>
          </TimelineNode>
        )
        i = j
        continue
      }
    }
    rendered.push(renderPart(parts[i], i))
    i++
  }
  return (
    <div className="flex flex-col gap-1">
      {stamp}
      <div className="flex flex-col">{rendered}</div>
      {m.metadata?.interrupted && <p className="text-caption text-muted">{t('ai.interrupted')}</p>}
      {m.metadata?.contextCompressed && (
        <p className="text-caption text-muted">{t('ai.contextCompressed')}</p>
      )}
      {m.metadata?.finishReason === 'step-limit' && (
        <p className="text-caption text-muted">{t('ai.stepLimit')}</p>
      )}
      {m.metadata?.finishReason === 'length' && (
        <p className="text-caption text-muted">{t('ai.outputLimit')}</p>
      )}
      {m.metadata?.error && (
        <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-body text-danger">
          {m.metadata.error}
        </div>
      )}
    </div>
  )
})

/** 输入框高度下限（约 3 行，VS Code 风格大输入区）与上限 */
const COMPOSER_MIN_H = 72
const COMPOSER_MAX_H = 200

/** 审批强度图标（盾牌系，与设置页同语义）：严格=盾+勾（安全）/ 默认=盾 / 宽松=盾+叹号（需警惕）；
 *  颜色沿用 严格=蓝 / 默认=绿 / 宽松=红 */
const APPROVAL_ICONS: Record<AiApprovalLevel, LucideIcon> = {
  strict: ShieldCheck,
  default: Shield,
  relaxed: ShieldAlert
}
const APPROVAL_ICON_CLS: Record<AiApprovalLevel, string> = {
  strict: 'text-info',
  default: 'text-ok',
  relaxed: 'text-danger'
}
const APPROVAL_LEVELS: {
  value: AiApprovalLevel
  labelKey:
    'settings.aiApprovalStrict' | 'settings.aiApprovalDefault' | 'settings.aiApprovalRelaxed'
}[] = [
  { value: 'strict', labelKey: 'settings.aiApprovalStrict' },
  { value: 'default', labelKey: 'settings.aiApprovalDefault' },
  { value: 'relaxed', labelKey: 'settings.aiApprovalRelaxed' }
]
/** 主机/命令弹出菜单最多展示条数 */
const MENU_MAX = 8

/**
 * VS Code 风格大输入区：上方审批档位 + 待批跳转；下方无内边框 textarea + 工具行（模型 / 发送）。
 * 斜杠命令与 @主机补全仍锚在输入区上方；语义展开发生在 stores/ai.send → lib/aiInput.buildPayload.
 */
function ChatComposer({
  sessionId,
  busy,
  disabled,
  placeholder,
  onSend,
  onCancel,
  onViewApprovals
}: {
  sessionId: string
  busy: boolean
  disabled: boolean
  placeholder: string
  onSend: (text: string) => void
  onCancel: () => void
  /** 滚动到首个待人工审批的工具卡 */
  onViewApprovals: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const conns = useConnectionsStore((s) => s.connections)
  const attachments = useWorkspaceStore((s) => s.attachments[sessionId])
  const focusedId = useWorkspaceStore((s) => s.focusedHostId)
  const focusedHost = conns.find((c) => c.id === focusedId)
  const references = conns.filter((c) => attachments?.includes(c.id))
  const phases = useLinksStore((s) => s.byHost)
  const ai = usePrefsStore((s) => s.data?.ai ?? null)
  const updatePrefs = usePrefsStore((s) => s.update)
  const setTab = useSessionStore((s) => s.setTab)
  /** 待审批数：>0 时输入框光圈切黄闪（与工具卡黄框同语义） */
  const pendingCount = useAiStore(
    (s) => pendingApprovals(s.sessions.find((x) => x.id === sessionId)?.messages ?? []).length
  )
  /** 本会话挂起的人工输入待办（密码/验证码）：同样需要人来处理，故与待审批合并计入 */
  const pendingInputCount = useHumanInputStore(
    (s) => Object.values(s.pending).filter((r) => r.sessionId === sessionId).length
  )
  /** 需要人处理的挂起项总数：驱动跳转胶囊与输入区黄闪光圈 */
  const humanPending = pendingCount + pendingInputCount
  /** 会话内是否仍有 running 执行：对话 turn 已结束但后台命令还在跑时，光圈保持彩虹 */
  const [hasRunningExec, setHasRunningExec] = useState(false)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      try {
        const tasks = await window.aterm.executions.list(sessionId)
        if (active)
          setHasRunningExec(
            tasks.some((task) => task.status === 'starting' || task.status === 'running')
          )
      } catch {
        if (active) setHasRunningExec(false)
      }
      if (active) timer = setTimeout(() => void refresh(), 1000)
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [sessionId])
  /** 对话场景当前绑定（下拉选中值） */
  const chatBinding = ai?.scenarios.chat ?? null
  const contextUsage = useAiStore((s) => s.sessions.find((x) => x.id === sessionId)?.contextUsage)
  /** 可选对话模型 = 供应商 × 已缓存模型列表（缓存来自设置页自动拉取） */
  const chatOptions = (ai?.providers ?? []).flatMap((p) =>
    (ai?.modelCache?.[p.id] ?? []).map((model) => ({ providerId: p.id, label: p.label, model }))
  )

  const [text, setText] = useState('')
  /** 'cmd' | 'mention' | null：当前打开的弹出层（模型选择已改为 Select 下拉） */
  const [menu, setMenu] = useState<'cmd' | 'mention' | null>(null)
  const [menuIdx, setMenuIdx] = useState(0)
  /** 宽松模式确认条：与设置页同语义，确认后才真正放宽审批 */
  const [relaxedConfirm, setRelaxedConfirm] = useState(false)
  /** 当前菜单的过滤词（命令 token 或 @ 后已输入部分；由 recomputeMenu 写入，渲染只读 state） */
  const [menuQuery, setMenuQuery] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const caretRef = useRef(0)

  /* auto-grow：高度随内容增长（下限 3 行），封顶后内部滚动 */
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, COMPOSER_MIN_H), COMPOSER_MAX_H)}px`
  }, [text])

  /* 新建或切换会话（sessionId 变化）后自动聚焦输入框，落位即可输入 */
  useEffect(() => {
    taRef.current?.focus()
  }, [sessionId])

  /** 光标/内容变化后重算菜单开闭与过滤词（命令形态仅限整条输入即命令本身） */
  const recomputeMenu = (next: string, caret: number): void => {
    const mention = activeMention(next, caret)
    if (mention !== undefined) {
      setMenu('mention')
      setMenuQuery(mention)
      setMenuIdx(0)
      return
    }
    const cmd = activeCommandToken(next)
    if (cmd !== undefined) {
      setMenu('cmd')
      setMenuQuery(cmd)
      setMenuIdx(0)
      return
    }
    setMenu(null)
  }

  const cmdItems = SLASH_COMMANDS.filter((c) => c.startsWith(activeCommandToken(text) ?? ''))
  const q = menu === 'mention' ? menuQuery.toLowerCase() : ''
  const hostItems = conns
    .filter((c) => c.name.toLowerCase().includes(q) || c.host.toLowerCase().includes(q))
    .slice(0, MENU_MAX)

  const applyMenu = (): void => {
    const el = taRef.current
    const caret = el?.selectionStart ?? caretRef.current
    if (menu === 'cmd') {
      const id = cmdItems[menuIdx]
      if (!id) return
      const next = `/${id} `
      setText(next)
      setMenu(null)
      const pos = next.length
      requestAnimationFrame(() => {
        el?.focus()
        el?.setSelectionRange(pos, pos)
      })
      return
    }
    const host = hostItems[menuIdx]
    if (!host || !ai) return
    const before = text.slice(0, caret)
    const at = before.lastIndexOf('@')
    const next = `${text.slice(0, at)}@${host.name} ${text.slice(caret)}`
    setText(next)
    setMenu(null)
    const pos = at + host.name.length + 2
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  const submit = (): void => {
    if (!text.trim() || busy || disabled) return
    onSend(text)
    setText('')
    setMenu(null)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menu === 'cmd' || menu === 'mention') {
      const n = menu === 'cmd' ? cmdItems.length : hostItems.length
      if (n > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setMenuIdx((i) => (i + 1) % n)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setMenuIdx((i) => (i - 1 + n) % n)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          applyMenu()
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenu(null)
        return
      }
    }
    // Enter 发送；Cmd/Ctrl+Enter（或 Shift+Enter）换行；IME 组合中不误发
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return // 交给 textarea 默认换行
      e.preventDefault()
      submit()
    }
  }

  return (
    <div>
      {/* 输入区上方：审批档位（左）+ 宽松确认（选择器右侧）+ 待批时居中「查看审批项」 */}
      <div className="relative mb-2 flex min-h-6 items-center gap-1.5">
        <Select
          value={ai?.approvalLevel ?? 'default'}
          onValueChange={(v) => {
            if (v === 'relaxed') {
              setRelaxedConfirm(true)
              return
            }
            setRelaxedConfirm(false)
            if (ai) updatePrefs({ ai: { ...ai, approvalLevel: v as AiApprovalLevel } })
          }}
        >
          <SelectTrigger
            aria-label={t('settings.aiApprovalLevel')}
            className="h-5 w-auto shrink-0 gap-1 border-none bg-transparent px-1 text-caption shadow-none hover:bg-hover"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent side="top">
            {APPROVAL_LEVELS.map((o) => {
              const Icon = APPROVAL_ICONS[o.value]
              return (
                <SelectItem key={o.value} value={o.value} className="text-caption">
                  <span className="flex items-center gap-1.5">
                    <Icon size={11} className={APPROVAL_ICON_CLS[o.value]} />
                    {t(o.labelKey)}
                  </span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        {relaxedConfirm && (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className="min-w-0 flex-1 truncate text-caption text-danger"
              title={t('settings.aiRelaxedMessage')}
            >
              {t('settings.aiRelaxedMessage')}
            </span>
            <button
              type="button"
              className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-caption font-medium text-danger transition-colors hover:bg-danger/10"
              onClick={() => {
                setRelaxedConfirm(false)
                if (ai) updatePrefs({ ai: { ...ai, approvalLevel: 'relaxed' } })
              }}
            >
              {t('common.ok')}
            </button>
            <button
              type="button"
              className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-caption text-muted transition-colors hover:bg-hover hover:text-fg"
              onClick={() => setRelaxedConfirm(false)}
            >
              {t('common.cancel')}
            </button>
          </div>
        )}
        {humanPending > 0 && !relaxedConfirm && (
          <button
            type="button"
            onClick={onViewApprovals}
            className="ai-approval-jump absolute left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-warn/50 bg-warn/15 px-2.5 py-0.5 text-caption font-medium text-warn"
          >
            {pendingInputCount > 0 ? (
              <Lock size={11} strokeWidth={2.2} className="shrink-0" />
            ) : (
              <ShieldAlert size={11} strokeWidth={2.2} className="shrink-0" />
            )}
            {t(pendingInputCount > 0 ? 'ai.viewInput' : 'ai.viewApprovals')}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {/* 大输入容器：光圈三态（审批/输入黄闪 · 会话活动彩虹 · 空闲普通描边+聚焦绿边） */}
        <div
          className={cn(
            'rounded-xl border bg-raised transition-colors duration-100',
            humanPending > 0
              ? 'ai-ring-approval'
              : busy || hasRunningExec
                ? 'ai-ring-busy'
                : 'border-line focus-within:border-at-accent/60'
          )}
        >
          <div className="relative">
            {(focusedHost || references.length > 0) && (
              <div className="flex flex-wrap gap-1 px-2 pt-2">
                {focusedHost && (
                  <span
                    title={`${focusedHost.host}:${focusedHost.port}`}
                    className="flex min-w-0 max-w-full items-center gap-1 rounded-md bg-hover px-2 py-1 text-caption text-muted"
                  >
                    <Server size={12} />
                    {t('ai.focusedHost')}: <span className="truncate">{focusedHost.name}</span>
                  </span>
                )}
                {references.map((host) => (
                  <span
                    key={host.id}
                    title={`${host.host}:${host.port}`}
                    className="flex max-w-full items-center gap-1 rounded-md border border-line bg-raised px-2 py-1 text-caption"
                  >
                    <Server size={12} />
                    <span className="truncate">{host.name}</span>
                    <IconButton
                      icon={X}
                      frame={18}
                      title={t('ai.removeHostReference')}
                      onClick={() => useWorkspaceStore.getState().removeHost(sessionId, host.id)}
                    />
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={taRef}
              rows={3}
              value={text}
              placeholder={placeholder}
              onChange={(e) => {
                setText(e.target.value)
                caretRef.current = e.target.selectionStart ?? 0
                recomputeMenu(e.target.value, e.target.selectionStart ?? 0)
              }}
              onKeyUp={() => {
                caretRef.current = taRef.current?.selectionStart ?? caretRef.current
              }}
              onClick={() => {
                caretRef.current = taRef.current?.selectionStart ?? caretRef.current
                recomputeMenu(text, taRef.current?.selectionStart ?? text.length)
              }}
              onKeyDown={onKeyDown}
              style={{ maxHeight: COMPOSER_MAX_H, minHeight: COMPOSER_MIN_H }}
              className="no-drag block w-full resize-none bg-transparent px-3 py-2.5 text-body leading-relaxed text-fg placeholder:text-muted outline-none"
            />
            {/* 补全菜单：锚在输入区上方 */}
            {menu !== null && (
              <div className="absolute bottom-full left-0 z-20 mb-1.5 max-h-56 w-80 overflow-y-auto rounded-lg border border-line bg-raised shadow-lg">
                {menu === 'cmd' ? (
                  cmdItems.length > 0 ? (
                    cmdItems.map((id, i) => (
                      <button
                        key={id}
                        type="button"
                        className={cn(
                          'flex w-full items-center gap-2 px-2.5 py-1.5 text-left',
                          i === menuIdx && 'bg-hover'
                        )}
                        onMouseEnter={() => setMenuIdx(i)}
                        onClick={applyMenu}
                      >
                        <span className="font-mono text-minor text-fg">/{id}</span>
                        <span className="ml-auto truncate text-caption text-muted">
                          {t(`ai.cmd.${id}Label`)} · {t(`ai.cmd.${id}Desc`)}
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="px-2.5 py-1.5 text-caption text-muted">
                      {t('ai.mentionNoHosts')}
                    </div>
                  )
                ) : hostItems.length > 0 ? (
                  hostItems.map((c, i) => (
                    <button
                      key={c.id}
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-2 px-2.5 py-1.5 text-left',
                        i === menuIdx && 'bg-hover'
                      )}
                      onMouseEnter={() => setMenuIdx(i)}
                      onClick={applyMenu}
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: linkStateColor(phases[c.id]?.phase) }}
                      />
                      <span className="shrink-0 font-mono text-minor text-fg">@{c.name}</span>
                      <span className="truncate text-caption text-muted">
                        {c.host}:{c.port}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-2.5 py-1.5 text-caption text-muted">
                    {t('ai.mentionNoHosts')}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 底部工具行：模型切换器（左）+ 发送/停止（右） */}
          <div className="relative flex items-center gap-1.5 px-2 pb-2 pt-0.5">
            <ExecutionSessionsButton key={sessionId} sessionId={sessionId} />
            <Select
              value={chatBinding?.model ? `${chatBinding.providerId}|${chatBinding.model}` : ''}
              onValueChange={(v) => {
                if (v === '__manage__') {
                  setTab({ kind: 'settings', section: 'ai' })
                  return
                }
                if (!ai) return
                const sep = v.indexOf('|')
                updatePrefs({
                  ai: {
                    ...ai,
                    scenarios: {
                      ...ai.scenarios,
                      chat: { providerId: v.slice(0, sep), model: v.slice(sep + 1) }
                    }
                  }
                })
              }}
            >
              <SelectTrigger
                aria-label={t('ai.modelTitle')}
                className="h-7 w-auto max-w-56 gap-1 border-none bg-transparent px-1.5 text-minor shadow-none hover:bg-hover"
              >
                <SelectValue placeholder={t('ai.modelNone')} />
              </SelectTrigger>
              <SelectContent side="top" className="max-h-72 w-80">
                {chatOptions.length === 0 ? (
                  <div className="px-2.5 py-1.5 text-caption text-muted">
                    {t('ai.modelMenuEmpty')}
                  </div>
                ) : (
                  chatOptions.map((o) => (
                    <SelectItem
                      key={`${o.providerId}|${o.model}`}
                      value={`${o.providerId}|${o.model}`}
                      className="text-minor"
                    >
                      <span className="flex w-full min-w-0 items-center gap-2">
                        <span className="w-20 shrink-0 truncate">{o.label}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-muted">
                          {o.model}
                        </span>
                      </span>
                    </SelectItem>
                  ))
                )}
                <SelectSeparator className="bg-chrome-sep" />
                <SelectItem value="__manage__" className="text-muted">
                  {t('ai.manageModels')}
                </SelectItem>
              </SelectContent>
            </Select>

            <span className="flex-1" />
            {busy ? (
              <button
                type="button"
                onClick={onCancel}
                title={t('ai.stop')}
                className="flex h-7 w-7 cursor-pointer shrink-0 items-center justify-center rounded-xl bg-danger text-white transition-opacity hover:opacity-90"
              >
                <Square size={11} strokeWidth={2.4} />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!text.trim() || disabled}
                title={t('ai.send')}
                className="flex h-7 w-7 cursor-pointer shrink-0 items-center justify-center rounded-xl bg-at-accent text-white transition-opacity hover:opacity-90 disabled:opacity-35"
              >
                <ArrowUp size={14} strokeWidth={2.6} />
              </button>
            )}
          </div>
        </div>
        {ai && chatBinding?.model && (
          <ContextUsageIndicator
            usage={contextUsage}
            modelKey={modelSettingsKey(chatBinding)}
            contextWindow={contextSettingsFor(ai).contextWindow}
          />
        )}
      </div>
    </div>
  )
}

/** 「回到底部」判定阈值：距底小于该值视为跟随中 */
const FOLLOW_THRESHOLD = 48

/** 会话列表时间：M/D HH:mm（紧凑、数字本地化无关） */
function fmtListTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 会话列表（VS Code Copilot 风格历史）：按最近活动排序，点击进入；状态点 = 待审批(黄)/生成中(蓝)；行尾删除 */
function SessionList({
  sessions,
  activeId,
  onOpen,
  onClose
}: {
  sessions: AiSession[]
  activeId: string | null
  onOpen: (id: string) => void
  onClose: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
      {sorted.map((s) => (
        <div
          key={s.id}
          role="button"
          tabIndex={0}
          aria-pressed={s.id === activeId}
          onClick={() => onOpen(s.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onOpen(s.id)
          }}
          className={cn(
            'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-hover',
            s.id === activeId && 'bg-hover/60'
          )}
        >
          <span className="flex w-2 shrink-0 justify-center">
            {pendingApprovals(s.messages).length > 0 ? (
              <StateDot visual={solidDot('var(--at-warn)')} />
            ) : isBusy(s) ? (
              <StateDot visual={solidDot('var(--at-accent)')} />
            ) : null}
          </span>
          <span className="min-w-0 flex-1 truncate text-minor text-fg">{sessionTitle(s)}</span>
          <span className="shrink-0 text-caption text-muted">{fmtListTime(s.updatedAt)}</span>
          <span className="opacity-0 transition-opacity group-hover:opacity-100">
            <IconButton
              icon={X}
              size={11}
              frame={22}
              aria-label={t('common.close')}
              onClick={(e) => {
                e.stopPropagation()
                onClose(s.id)
              }}
            />
          </span>
        </div>
      ))}
    </div>
  )
}

export function AiWorkspacePage(): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useAiStore((s) => s.sessions)
  const activeId = useAiStore((s) => s.activeId)
  const init = useAiStore((s) => s.init)
  const newSession = useAiStore((s) => s.newSession)
  const closeSession = useAiStore((s) => s.closeSession)
  const activate = useAiStore((s) => s.activate)
  const send = useAiStore((s) => s.send)
  const cancel = useAiStore((s) => s.cancel)

  const active = sessions.find((s) => s.id === activeId) ?? null
  const initError = useAiStore((s) => s.initError)
  /** 本会话挂起的人工输入待办：卡片排在对话末尾（见 HumanInputCard），不嵌进历史工具卡 */
  const inputRequests = useHumanInputStore(
    useShallow((s) => Object.values(s.pending).filter((r) => r.sessionId === activeId))
  )

  /** 右侧对话面板宽度（拖拽手柄可调，双击复位） */
  const PANEL_MIN = 360
  const PANEL_MAX = 720
  const PANEL_DEFAULT = 460
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT)
  /** 面板视图：chat = 当前会话对话；list = 全部会话列表（VS Code Copilot 风格导航） */
  const [view, setView] = useState<'chat' | 'list'>('chat')

  const startPanelResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = panelWidth
    const onMove = (ev: PointerEvent): void => {
      const next = startWidth + (startX - ev.clientX)
      setPanelWidth(Math.min(PANEL_MAX, Math.max(PANEL_MIN, next)))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('select-none')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    document.body.classList.add('select-none')
  }
  const scrollRef = useRef<HTMLDivElement>(null)

  /* 滚动跟随：上翻即停止贴底（想回看历史时不被流式输出拽走），发送/切会话恢复跟随 */
  const [following, setFollowing] = useState(true)

  useEffect(() => {
    void init()
  }, [init])

  /* 外部入口（主机备注「Agent 代填」等）发起的对话：列表视图下切回对话视图，否则看不到刚发出的消息。
     渲染期调整（与本文件其他判重同套路），挂载时视为已消费，不影响正常进入页面时的视图 */
  const viewChatRequest = useAiStore((s) => s.viewChatRequest)
  const [seenViewChatRequest, setSeenViewChatRequest] = useState(viewChatRequest)
  if (viewChatRequest !== seenViewChatRequest) {
    setSeenViewChatRequest(viewChatRequest)
    setView('chat')
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el && following) el.scrollTop = el.scrollHeight
    // 末尾的输入卡片出现/收起时同样贴底（只在跟随态）
  }, [active?.messages, following, inputRequests.length])

  // 切换会话回到跟随态（不同会话的滚动位置无回看意义）；渲染期调整，避免 effect 级联
  const [prevActiveId, setPrevActiveId] = useState(activeId)
  if (prevActiveId !== activeId) {
    setPrevActiveId(activeId)
    setFollowing(true)
  }

  const handleSend = (text: string): void => {
    setFollowing(true)
    send(text)
  }

  const jumpToBottom = (): void => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setFollowing(true)
  }

  /** 停跟随并滚到首个待人工处理项（审批或人工输入） */
  const jumpToApproval = (): void => {
    setFollowing(false)
    requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>('[data-approval-pending], [data-input-pending]')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  const handleNewSession = (): void => {
    void newSession()
    setView('chat')
  }

  return (
    <div className="flex h-full">
      {/* 拖拽手柄：上下限 360–720px，双击复位 */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={startPanelResize}
        onDoubleClick={() => setPanelWidth(PANEL_DEFAULT)}
        className="z-10 w-1 shrink-0 cursor-col-resize bg-chrome-sep transition-colors hover:bg-at-accent/60"
      />
      {/* 右侧：对话面板（VS Code Copilot 风格：← 返回会话列表 / 列表点选进入会话） */}
      <div
        className="flex h-full shrink-0 flex-col"
        style={{ width: panelWidth, maxWidth: '50vw' }}
      >
        {/* 头部：聊天视图（← + 当前会话标题）/ 列表视图（所有会话）；右端恒为新建 */}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-chrome-sep px-3">
          {view === 'chat' && (
            <IconButton
              variant="toolbar"
              icon={ArrowLeft}
              size={13}
              frame={24}
              title={t('ai.backToList')}
              onClick={() => setView('list')}
            />
          )}
          {view === 'chat' && active?.titlePending && (
            <Loader2 size={12} className="shrink-0 animate-spin text-muted" />
          )}
          <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">
            {view === 'chat'
              ? active
                ? sessionTitle(active)
                : t('ai.title')
              : t('ai.allSessions')}
          </span>
          <IconButton
            variant="toolbar"
            icon={Plus}
            size={12}
            frame={22}
            cornerRadius={11}
            filled
            aria-label={t('ai.newSession')}
            onClick={handleNewSession}
          />
        </div>

        {view === 'list' ? (
          <SessionList
            sessions={sessions}
            activeId={activeId}
            onOpen={(id) => {
              activate(id)
              setView('chat')
            }}
            onClose={closeSession}
          />
        ) : active ? (
          <>
            {/* 消息列表（滚动跟随：following=false 时不再贴底）；待审批内嵌在对应工具卡内 */}
            <div className="relative min-h-0 flex-1">
              <div
                ref={scrollRef}
                className="h-full overflow-y-auto px-4 py-3"
                onScroll={() => {
                  const el = scrollRef.current
                  if (!el) return
                  const near = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD
                  setFollowing(near)
                }}
              >
                {active.messages.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-1.5 text-muted">
                    <Bot size={28} strokeWidth={1.6} />
                    <span className="text-body">{t('ai.empty')}</span>
                    <span className="text-caption">{t('ai.emptyHint')}</span>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {active.messages.map((m) => (
                      <MessageItem key={m.id} m={m} sessionId={active.id} />
                    ))}
                    {/* 处理指示器：agent 思考/调用工具中（后台命令运行由光圈表达，不在此重复） */}
                    {(active.stopping ||
                      active.status === 'submitted' ||
                      active.status === 'streaming') && (
                      <div className="flex items-center gap-1.5 text-caption text-muted">
                        <Loader2 size={11} className="animate-spin" />
                        {t(active.stopping ? 'ai.stopping' : 'ai.processing')}
                      </div>
                    )}
                    {active.error &&
                      !active.messages.some(
                        (m) =>
                          m.metadata?.error === active.error?.message ||
                          m.parts.some(
                            (p) =>
                              isToolUIPart(p) &&
                              p.state === 'output-error' &&
                              p.errorText.includes(active.error!.message)
                          )
                      ) && (
                        <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-body text-danger">
                          {active.error.message}
                        </p>
                      )}
                    {/* 人工输入卡片：排在对话末尾（agent 提示之后），与 VS Code 提问卡同位 */}
                    {inputRequests.map((request) => (
                      <HumanInputCard key={request.executionId} request={request} />
                    ))}
                  </div>
                )}
              </div>
              {/* 上翻离底时出现；点击平滑回底并恢复跟随 */}
              {!following && (
                <button
                  type="button"
                  onClick={jumpToBottom}
                  aria-label={t('ai.backToBottom')}
                  title={t('ai.backToBottom')}
                  className="absolute bottom-3 right-4 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-raised text-muted shadow-md transition-colors hover:text-fg"
                >
                  <ArrowDown size={13} strokeWidth={2.2} />
                </button>
              )}
            </div>

            {/* 输入区（多行 + /命令 + @主机；发送/停止按钮由 Composer 持有） */}
            <div className="shrink-0 border-t border-chrome-sep p-3">
              <ChatComposer
                key={active.id}
                sessionId={active.id}
                busy={isBusy(active)}
                disabled={!active.loaded || active.id.startsWith('pending:')}
                placeholder={t('ai.placeholder')}
                onSend={handleSend}
                onCancel={cancel}
                onViewApprovals={jumpToApproval}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-muted">
            <Bot size={28} strokeWidth={1.6} />
            <span className="text-body">{t('ai.loading')}</span>
            {initError && (
              <span className="max-w-md text-center text-caption text-danger">{initError}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default AiWorkspacePage
