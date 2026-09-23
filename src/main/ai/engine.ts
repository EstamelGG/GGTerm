import { BrowserWindow, app } from 'electron'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { generateText } from 'ai'
import type { ToolApprovalStatus, UIMessageChunk } from 'ai'
import type { AiEvent, AiSessionSummary, AiUIMessage } from '../../shared/types'
import { errorMessage } from '../../shared/error'
import { contextSettingsFor, modelSettingsKey } from '../../shared/ai'
import { getPreferences, setPreferences } from '../data/prefs'
import { getApiKey } from '../data/aiSecrets'
import { appLog } from '../log'
import { resolveLocale } from '../i18n'
import { createChatModel } from './provider'
import { aiTools, type AiToolName } from './tools'
import { sftpOf } from './tools/shared'
import {
  initAgent,
  createAgentSession,
  listAgentSessions,
  deleteAgentSession,
  getAgentSession,
  getAgentTurnId,
  setAgentTitle,
  startTurn,
  cancelAgentTurn,
  type AgentDeps
} from './agent'
import { reclaimAgentSession } from './agentLinks'
import { executions } from './exec'
import {
  judgeCommand,
  judgeConfig,
  judgeLocalWrite,
  judgeSftpWrite,
  judgeSessionClose,
  type GateDecision
} from './gate'

/**
 * AI 引擎：electron 侧接线。IPC 会话生命周期、BYOK 模型解析、风险门 → SDK toolApproval、
 * 回合流片广播（ai:event）、会话标题刷新。回合执行与持久化由 ./agent 承担。
 */

/** 本机操作系统：本机工具（local_*）的 shell 与路径形态随平台不同，提示里显式告知模型 */
const LOCAL_OS =
  process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'

const SYSTEM = `You are the built-in SSH ops assistant of GGTerm, operating saved SSH connections and sessions directly.
Rules:
1. Host addressing: hostId must come from the id field returned by list_hosts — never invent or guess one. When the user mentions a host by name/IP, call list_hosts first to resolve it (results also carry per-host transport counts split by owner, a duplicate flag, and — with includeNote=true — the note; request the note only when its content is actually needed). To see the transports themselves — one entry per real connection, split user/agent, with the jump chain actually in use — use list_connections instead. Other tools auto-connect when needed, so no explicit connect is required. If nothing matches, list the closest candidates and let the user choose.
2. Prefer tools over shell: remote files go through sftp_read/sftp_list/sftp_write/sftp_patch/sftp_delete instead of cat/ls/rm/rmdir; local files go through local_read/local_list/local_stat/local_write/local_patch/local_grep instead of cat/ls/grep/rm. Fall back to commands only when a tool cannot express the operation. Both read tools return a window of lines (offset/limit, plus nextOffset when cut short): page through a large file instead of asking for all of it at once.
3. Run one command at a time; never chain compound commands (no &&, ;, |). Tools called in the same step run in declaration order (same as card order); calls on different hosts may proceed concurrently, but anything touching the same host is serialized — still prefer one mutating tool per step when operations depend on each other.
4. All remote commands run via execute in a background remote shell; user terminal tabs are never opened. execute is remote-only — local commands go through local_exec (one-shot, non-interactive). For start, hostId must come from list_hosts; command is optional — omitting it just opens a remote shell (requires confirmation). Every execute call must carry a one-line description of the intent, written in the language the user writes in (shown to the user). Later input on the same executionId (must end with a newline) keeps cwd, env and login state. The user can only view output in this session's execution list or terminate it — they cannot type in the viewer. A password/verification-code prompt parks the execute call instead of returning to you: an input card appears in the chat and the user submits the value there themselves (it never reaches you), so the call resumes only after they act — humanInputOutcome tells you how (submitted / cancelled / expired). Never ask for the secret in chat and never pass sensitive input through the model. running means the shell is alive; completed/exitCode describe only the shell itself, not the foreground command. Output is polled at most every 60s; a detected prompt is a hint to inspect output, never proof of success — do not claim success or rerun. cancel sends Ctrl-C and usually keeps the shell; rollback is not guaranteed. Stopping generation or closing the viewer does not close the background shell. After terminationRequested or unknown, never touch or auto-rerun the task.
5. Destructive operations (delete, service restart, config changes) will require human confirmation by the system; just report normally.
6. Host scope: the operation target must be specified by the user (host name or IP both work). If unsure which host, list candidates and let the user choose; never connect to or probe all hosts when the target is unclear. Bulk operations only with explicit user authorization, and write operations must be confirmed host by host.
7. Local file access (sftp_upload and all local_* tools): macOS may deny reading Downloads/Documents/Desktop (EPERM/EACCES in the tool error). Do NOT retry, and do NOT work around it with another local path, write_temp_file or a different tool. Do NOT claim the file is empty. Tell the user to grant access in System Settings → Privacy & Security → Files and Folders, then stop and wait.
8. Respect user-interruption markers in conversation history and summaries. Unfinished work from an interrupted turn is paused, not a standing instruction: follow the latest user request and resume earlier work only when the user explicitly asks to continue it. Never infer that interruption rolled back a command or that a missing result means it is safe to rerun.
9. Local machine (the user's own computer; this machine runs ${LOCAL_OS}): local_exec runs a single command in a login shell (PowerShell on Windows) and exits — there is no session to return to (pass an absolute path or fold cd into the same command) and no stdin (commands that prompt get EOF instead of hanging; never use it for interactive prompts such as passwords, editors or pagers). Write the command for that platform: POSIX syntax and paths on macOS/Linux, PowerShell syntax and drives/backslashes on Windows — do not assume the local OS is the same as the remote host's. Long output is capped to head+tail: redirect to a file and page it with local_read. Local paths are absolute, or relative to the home directory (~ accepted).
Always respond in the language the user writes in.`

/* ---------------- 事件广播（增量合并） ---------------- */

function broadcast(event: AiEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('ai:event', event)
  }
}

/** 待广播的 delta：50ms 合并窗口，仅用于节流 IPC 流量（不承担重放职责） */
const pendingDeltas = new Map<string, PendingDelta>()

type DeltaChunk = Extract<UIMessageChunk, { type: 'text-delta' | 'reasoning-delta' }>
interface PendingDelta {
  turnId: string
  chunk: DeltaChunk
  timer: ReturnType<typeof setTimeout>
}

const FLUSH_MS = 50

function sameDelta(a: DeltaChunk, b: DeltaChunk): boolean {
  return a.type === b.type && a.id === b.id
}

function flushPending(sessionId: string): void {
  const pending = pendingDeltas.get(sessionId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingDeltas.delete(sessionId)
  broadcast({ type: 'chunk', sessionId, turnId: pending.turnId, chunk: pending.chunk })
}

function emitChunk(sessionId: string, turnId: string, chunk: UIMessageChunk): void {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    const pending = pendingDeltas.get(sessionId)
    if (pending && pending.turnId === turnId && sameDelta(pending.chunk, chunk)) {
      pending.chunk = { ...pending.chunk, delta: pending.chunk.delta + chunk.delta }
      return
    }
    flushPending(sessionId)
    pendingDeltas.set(sessionId, {
      turnId,
      chunk,
      timer: setTimeout(() => flushPending(sessionId), FLUSH_MS)
    })
    return
  }
  flushPending(sessionId)
  broadcast({ type: 'chunk', sessionId, turnId, chunk })
}

/* ---------------- 后台执行完结通知 ---------------- */

const pausedExecutions = new Set<string>()

executions.onBackgroundFinish = (result) => {
  if (pausedExecutions.has(result.sessionId)) return
  // 用户或会话主动终止（卡片「终止命令」/ 查看器终止 / 待办超时 / 主机链路关闭）：
  // 无人等待时也无需唤醒模型 —— 否则会话里会多出一条 status=completed、signal=SIGHUP 的通知，
  // 让模型去 poll 一个已被杀掉的执行。终止事实由主进程日志与工具结果（若有等待者）承载。
  if (result.terminationRequested) {
    appLog('ai', `Execution ${result.executionId} terminated; skip agent notify`)
    return
  }
  // 链路断开（unknown）无可轮询内容：不注入 agent 通知，仅记日志避免误导模型重试
  if (result.status === 'unknown') {
    appLog('ai', `Execution ${result.executionId} ended unknown (link lost); skip agent notify`)
    return
  }
  // 以真实用户消息唤醒模型（渲染层 Chat 投递）；输出经 execute/poll 拉取，避免重复或超长上下文
  broadcast({
    type: 'notify',
    sessionId: result.sessionId,
    text: `[executor notification] executionId=${result.executionId}, status=${result.status}, exitCode=${result.exitCode}, signal=${result.signal ?? ''}. Read the result with execute poll; this notification is NOT authorization to rerun or start new commands.`
  })
}

/* ---------------- BYOK 配置 ---------------- */

/** 序列化为单行紧凑文本并截断（日志条目单行展示） */
function forLog(v: unknown, max = 4000): string {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v))
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 拉取供应商可用模型列表；结果写入 prefs 缓存。
 *  兼容 OpenAI 格式 {data:[{id}]} 与 Ollama 原生格式 {models:[{name|model}]}；全程写 ai 日志。 */
export async function listModels(providerId: string): Promise<string[]> {
  const ai = getPreferences().ai
  const provider = ai.providers.find((p) => p.id === providerId)
  if (!provider?.baseURL) throw new Error('Provider has no BaseURL configured')
  const apiKey = provider.noKey ? '' : getApiKey(provider.id)
  const url = `${provider.baseURL.replace(/\/+$/, '')}/models`
  const res = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
  }).catch((err: unknown) => {
    appLog(
      'ai',
      `Failed to fetch model list "${provider.label}" ${url}: ${errorMessage(err)}`,
      'error'
    )
    throw err
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    appLog(
      'ai',
      `Failed to fetch model list "${provider.label}" ${url}: HTTP ${res.status} ${forLog(body, 1500)}`,
      'error'
    )
    throw new Error(`Failed to fetch model list: HTTP ${res.status}`)
  }
  const text = await res.text()
  let ids: string[] = []
  try {
    const data = JSON.parse(text) as {
      data?: Array<{ id?: string }>
      models?: Array<{ name?: string; model?: string }>
    }
    if (Array.isArray(data.data)) ids = data.data.map((m) => m?.id ?? '').filter(Boolean)
    else if (Array.isArray(data.models))
      ids = data.models.map((m) => m?.name ?? m?.model ?? '').filter(Boolean)
  } catch {
    /* 非 JSON：下方按空结果记录原 body */
  }
  ids = [...new Set(ids)].sort((a, b) => a.localeCompare(b))
  if (ids.length === 0) {
    appLog(
      'ai',
      `Model list "${provider.label}" parsed empty, raw response: ${forLog(text, 2000)}`,
      'warning'
    )
    throw new Error('No models parsed from response (raw body in log panel)')
  }
  appLog('ai', `Fetched model list "${provider.label}" ${ids.length} items: ${ids.join(', ')}`)
  // 写缓存时重读最新偏好再合并：fetch 期间渲染层的其他变更不能被请求前的旧快照覆盖
  const cur = getPreferences().ai
  setPreferences({ ai: { ...cur, modelCache: { ...cur.modelCache, [provider.id]: ids } } })
  return ids
}

/* ---------------- 风险门 → SDK toolApproval ---------------- */

/** 配置结构变更类工具的审批卡文案（label 供 judgeConfig 组 reason，detail 组 command） */
const CONFIG_OPS: Record<
  string,
  { label: string; detail: (i: Record<string, unknown>) => string }
> = {
  add_connection: {
    label: 'Create connection',
    detail: (i) => `${i.name} (${i.username}@${i.host})`
  },
  edit_connection: { label: 'Edit connection', detail: (i) => String(i.hostId) },
  delete_connection: { label: 'Delete connection', detail: (i) => String(i.hostId) },
  add_group: { label: 'Create group', detail: (i) => String(i.name) },
  rename_group: { label: 'Rename group', detail: (i) => `${i.groupId} → ${i.name}` },
  delete_group: { label: 'Delete group', detail: (i) => String(i.groupId) }
}

const deny = (reason: string): ToolApprovalStatus => ({ type: 'denied', reason })

/** 判定归属标签（日志审计用）：哪层做的判定 + 放行还是转人工 */
function judgeLabel(d: GateDecision, relaxed: boolean): string {
  if (relaxed) return 'relaxed:auto'
  switch (d.level) {
    case 'whitelist':
      return 'safe:auto'
    case 'blacklist':
      return 'danger:manual'
    case 'strict':
      return 'strict:manual'
    case 'gray':
      return d.action === 'direct' ? 'ai:allow' : 'ai:manual'
    default:
      return `${d.level}:manual`
  }
}

/** 已记判定日志的 toolCall（SDK 在首次评估与审批续跑时重复调用 gate，同一调用只记一次） */
const auditedToolCalls = new Set<string>()

/** 命令判定审计（safeguard 频道）：同一 toolCall 只记首次判定 */
function auditCommand(
  toolCallId: string | undefined,
  command: string,
  decision: GateDecision,
  relaxed: boolean
): void {
  const dup = toolCallId ? auditedToolCalls.has(toolCallId) : false
  if (toolCallId) {
    auditedToolCalls.add(toolCallId)
    if (auditedToolCalls.size > 500) auditedToolCalls.clear()
  }
  if (dup) return
  appLog(
    'safeguard',
    `Command judge [${judgeLabel(decision, relaxed)}] ${forLog(command.trimEnd(), 300)}${decision.reason ? ` — ${decision.reason}` : ''}`
  )
}

/**
 * 三层风险门映射到 SDK 审批状态：direct → approved（自动放行徽标）；deny → denied（自动拦截，理由回传模型）；
 * confirm → user-approval（reason 为审批卡展示文案：命令 / 源与目的路径；流在此结束，渲染层写回响应后续跑）。
 */
const gateTool: NonNullable<AgentDeps['gate']> = async (
  sessionId,
  { toolName, input: args, toolCallId }
) => {
  const name = toolName as AiToolName
  const input = (args ?? {}) as Record<string, unknown>
  const prefs = getPreferences().ai
  let decision: GateDecision
  let command = ''

  switch (name) {
    case 'execute': {
      const action = String(input.action ?? '')
      // poll/list 只读查询：自动放行（与 HEAD 一致；漏掉会让后台执行环路全部被拒）
      if (action === 'poll' || action === 'list') return 'approved'
      const task =
        action === 'start'
          ? undefined
          : executions
              .list(sessionId)
              .find((t) => t.executionId === String(input.executionId ?? ''))
      // 任务不存在 = 运行时错误而非策略拒绝：放行交由工具本身抛错（工具卡按错误呈现）
      if (action !== 'start' && !task) return 'approved'
      if (action === 'cancel') {
        command = `Interrupt execution ${String(input.executionId)}`
        decision = judgeSessionClose(prefs)
      } else if (action === 'input') {
        if (task?.sensitiveInput)
          return deny(
            'Submitting sensitive input through the agent is forbidden; the viewer is read-only — report this interactive block'
          )
        command = String(input.input ?? '')
        // 写入交互式 shell 的 stdin 与新启命令同权判定：安全自动写入，危险/模糊走 AI/人工
        if (command.trim()) {
          decision = await judgeCommand(command, prefs, resolveLocale())
        } else {
          // 空输入（如仅回车刷 prompt）：无命令意图，宽松放行，其余人工确认
          decision =
            prefs.approvalLevel === 'relaxed'
              ? { action: 'direct', level: 'whitelist', reason: '' }
              : {
                  action: 'confirm',
                  level: 'session',
                  reason: `Sending input to a running task: ${task?.command ?? ''}`
                }
        }
      } else if (action === 'start') {
        if (String(input.target ?? '') === 'local')
          return deny(
            'execute is remote-only; use local_exec for local commands, or a hostId from list_hosts'
          )
        command = String(input.command ?? '')
        if (command.trim()) {
          decision = await judgeCommand(command, prefs, resolveLocale())
        } else {
          decision = {
            action: 'confirm',
            level: 'session',
            reason: 'Opening an interactive remote shell requires confirmation'
          }
        }
      } else return deny('Unknown execute action')
      auditCommand(toolCallId, command, decision, prefs.approvalLevel === 'relaxed')
      break
    }
    // 本机命令：与远端同一套命令判定（安全直行 / 危险或模糊转人工）
    case 'local_exec': {
      command = String(input.command ?? '')
      decision = await judgeCommand(command, prefs, resolveLocale())
      auditCommand(toolCallId, command, decision, prefs.approvalLevel === 'relaxed')
      break
    }
    // 本机文件写/编辑：与 SFTP 写同级（非宽松模式一律人工确认）
    case 'local_write':
    case 'local_patch':
      command = String(input.path ?? '')
      decision = judgeLocalWrite(prefs)
      break
    case 'sftp_write':
    case 'sftp_patch':
    case 'sftp_delete':
    case 'sftp_mkdir':
    case 'sftp_rename':
      command = String(input.path ?? input.src ?? '')
      decision = judgeSftpWrite(prefs)
      break
    case 'sftp_upload': {
      // 审批时解析精确落点：destDir 缺省 = 远端家目录（realpath，失败/超时回退 ~ 近似）
      const localPath = String(input.localPath ?? '')
      const base =
        localPath
          .split(/[\\/]+/)
          .filter(Boolean)
          .pop() ?? ''
      const destDir = String(input.destDir ?? '')
        .trim()
        .replace(/\/+$/, '')
      const hostId = input.hostId as string | undefined
      const home =
        destDir || !hostId
          ? ''
          : await Promise.race([
              sftpOf(hostId)
                .then((s) => s.realpath('.'))
                .catch(() => ''),
              new Promise<string>((resolve) => setTimeout(() => resolve(''), 1500))
            ])
      const destPath = destDir || home ? `${destDir || home}/${base}` : `~/${base}`
      command = `Source: ${localPath}\nDestination: ${destPath}`
      decision = judgeSftpWrite(prefs)
      break
    }
    case 'disconnect':
      command = name
      decision = judgeSessionClose(prefs)
      break
    case 'add_connection':
    case 'edit_connection':
    case 'delete_connection':
    case 'add_group':
    case 'rename_group':
    case 'delete_group': {
      const op = CONFIG_OPS[name]
      command = `${op.label} ${op.detail(input)}`
      decision = judgeConfig(op.label, prefs)
      break
    }
    default:
      // 其余读取、连接与下载工具直接放行（记录自动放行徽标）
      return 'approved'
  }

  if (decision.action === 'direct') return 'approved'
  if (decision.action === 'deny') return deny(decision.reason)
  appLog('ai', `Approval requested for ${name} [${decision.level}]: ${forLog(command, 500)}`)
  return { type: 'user-approval', reason: command }
}

/* ---------------- agent 接线 ---------------- */

let agentInited = false

/** 首次使用 AI 功能时初始化进程内 agent；模型每次调用重新解析（BYOK 变化即时生效） */
function ensureAgent(): void {
  if (agentInited) return
  agentInited = true
  // 旧版独立标题缓存已并入会话文件；残留文件直接删掉
  rmSync(join(app.getPath('userData'), 'ai-session-titles.json'), { force: true })
  initAgent({
    storageDir: join(app.getPath('userData'), 'ai-sessions'),
    getModel: () => createChatModel(getPreferences().ai, 'chat'),
    getContextSettings: () => contextSettingsFor(getPreferences().ai),
    getModelKey: () => {
      const binding = getPreferences().ai.scenarios.chat
      return binding ? modelSettingsKey(binding) : ''
    },
    onContextUsage: (sessionId, turnId, usage) =>
      broadcast({ type: 'context-usage', sessionId, turnId, usage }),
    tools: aiTools,
    instructions: SYSTEM,
    gate: gateTool,
    onLog: (message) => appLog('ai', message)
  })
}

/* ---------------- 会话标题（首次对话生成，每 3 轮基于既往对话刷新） ---------------- */

const TITLE_EVERY = 3
const TITLE_SYSTEM =
  'You generate session titles. Produce a short, accurate title for the conversation: at most 16 characters, in the language of the conversation, no quotes, periods or prefixes — output the title itself only.'
const titleGenerating = new Set<string>()

const msgText = (m: AiUIMessage): string =>
  m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')

/** 回合收尾时检查：首次对话即生成标题，此后每累计 10 条用户消息刷新一次（失败下轮重试） */
async function maybeRefreshTitle(sessionId: string): Promise<void> {
  const s = getAgentSession(sessionId)
  const users = s.messages.filter((m) => m.role === 'user')
  // titledAt = 0 表示尚未生成过标题：首条用户消息即触发；之后按 TITLE_EVERY 步进
  const step = s.titledAt === 0 ? 1 : TITLE_EVERY
  if (users.length - s.titledAt < step || titleGenerating.has(sessionId)) return
  titleGenerating.add(sessionId)
  broadcast({ type: 'title-pending', sessionId, pending: true })
  try {
    // 基于既往对话整体总结：近 20 条消息逐条截断拼成 trans（总量封顶），而非仅看本次对话
    const transcript = s.messages
      .slice(-20)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${msgText(m).slice(0, 200)}`)
      .join('\n')
      .slice(-2400)
    const res = await generateText({
      model: createChatModel(getPreferences().ai, 'title'),
      timeout: 60_000,
      system: TITLE_SYSTEM,
      prompt: `Conversation transcript (oldest first, truncated):\n${transcript}\n\nSummarize the whole conversation and generate a title:`
    })
    const title = res.text
      .trim()
      .replace(/^["'「『]+|["'」』。.]+$/g, '')
      .slice(0, 30)
    if (title) {
      setAgentTitle(sessionId, title)
      broadcast({ type: 'title', sessionId, title })
    }
  } catch (err) {
    appLog('ai', `Session title generation failed: ${errorMessage(err)}`, 'warning')
  } finally {
    titleGenerating.delete(sessionId)
    broadcast({ type: 'title-pending', sessionId, pending: false })
  }
}

/* ---------------- 会话生命周期（IPC） ---------------- */

export async function listSessions(): Promise<AiSessionSummary[]> {
  ensureAgent()
  return listAgentSessions()
}

export async function createSession(): Promise<AiSessionSummary> {
  createChatModel(getPreferences().ai, 'chat') // 供应商与模型齐备才可建会话
  ensureAgent()
  return createAgentSession()
}

export async function closeSession(sessionId: string): Promise<void> {
  pausedExecutions.add(sessionId)
  deleteAgentSession(sessionId)
  // 回收该对话占用的链路：空闲即关，执行在跑的等全部完结后自动关
  reclaimAgentSession(sessionId)
}

export async function getMessages(sessionId: string): Promise<AiUIMessage[]> {
  ensureAgent()
  const messages = getAgentSession(sessionId).messages
  // 打开历史会话时补生成缺失的标题（旧会话可能从未触发过：titledAt=0 且已有用户消息才会真正生成；
  // 已有标题或不足阈值时零开销返回），生成后经 title 广播刷新列表
  void maybeRefreshTitle(sessionId)
  return messages
}

/** 发起回合（渲染层 ChatTransport.sendMessages）：流片经 ai:event 广播，回合结束发 turn-end */
export async function run(
  sessionId: string,
  messages: AiUIMessage[],
  turnId: string
): Promise<void> {
  ensureAgent()
  const stream = startTurn(sessionId, messages, turnId)
  pausedExecutions.delete(sessionId)
  void (async () => {
    try {
      for await (const chunk of stream) emitChunk(sessionId, turnId, chunk)
    } catch (err) {
      emitChunk(sessionId, turnId, { type: 'error', errorText: errorMessage(err) })
    } finally {
      flushPending(sessionId)
      broadcast({ type: 'turn-end', sessionId, turnId })
      void maybeRefreshTitle(sessionId).catch(() => {})
    }
  })()
}

/** 取消当前生成：流以 abort 收尾，已产出内容由 agent 持久化 */
export async function cancel(sessionId: string, turnId?: string): Promise<AiUIMessage[]> {
  if (turnId && getAgentTurnId(sessionId) !== turnId) return getAgentSession(sessionId).messages
  pausedExecutions.add(sessionId)
  return cancelAgentTurn(sessionId, turnId)
}
