import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  ToolLoopAgent,
  generateText,
  convertToModelMessages,
  isToolUIPart,
  pruneMessages,
  stepCountIs,
  tool,
  toUIMessageStream
} from 'ai'
import type { LanguageModel, ToolApprovalStatus, ToolSet, UIMessageChunk } from 'ai'
import { toJSONSchema, type ZodType } from 'zod'
import type {
  AiContextSettings,
  AiContextUsage,
  AiSessionSummary,
  AiUIMessage
} from '../../shared/types'
import { DEFAULT_CONTEXT_SETTINGS } from '../../shared/ai'
import { errorMessage } from '../../shared/error'
import {
  compactContext,
  estimateTokens,
  SUMMARY_INSTRUCTIONS,
  type ContextSummary
} from './context'
import { abortableStream } from './abortableStream'

/**
 * 进程内 agent 运行时（AI SDK v7 原生形态）：
 *   每会话一个 ToolLoopAgent（工具闭包持有 sessionId），UIMessage 即持久化格式，
 *   convertToModelMessages 生成上下文，toUIMessageStream(originalMessages) 产出 UI 流片；
 *   审批走 SDK toolApproval（user-approval 结束本次流，渲染层 Chat 写回响应后续跑）；
 *   同一步多工具的并发由「资源锁键」控制：同键按 tool call / 卡片顺序 FIFO，无键直行（SDK 默认 Promise.all）。
 * 不依赖 electron：模型/工具/存储目录/审批门全部注入，可在 vitest 中独立验证。
 */

/* ---------------- 依赖注入 ---------------- */

export interface ToolInvocation {
  sessionId: string
  toolCallId: string
  /** 回合中断信号（用户取消生成时置位；轮询等待据此提前返回） */
  signal?: AbortSignal
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- handler 入参形状由各工具的 zod schema 约束
export interface AgentTool<T = any> {
  name: string
  description?: string
  parameters: ZodType<T>
  /** 资源锁键：同键调用在本会话内 FIFO，省略/返回 null = 直行（只读或纯计算）。策略见 tools/index.ts */
  lockKey?: (input: T) => string | null
  handler: (args: T, invocation: ToolInvocation) => Promise<unknown>
}

export interface AgentDeps {
  storageDir: string
  /** 每次调用解析模型（BYOK 绑定/密钥变化即时生效；未配置时抛错） */
  getModel: () => LanguageModel
  tools: AgentTool[]
  instructions: string | (() => string)
  /** 工具审批门（SDK ToolApprovalStatus：not-applicable/approved/denied/user-approval）；
   *  SDK 在首次评估与审批续跑时会对同一 toolCall 重复调用，toolCallId 供调用方去重审计日志 */
  gate?: (
    sessionId: string,
    toolCall: { toolName: string; input: unknown; toolCallId?: string }
  ) => ToolApprovalStatus | Promise<ToolApprovalStatus>
  onLog?: (message: string) => void
  getContextSettings?: () => AiContextSettings
  getModelKey?: () => string
  onContextUsage?: (sessionId: string, turnId: string, usage: AiContextUsage) => void
  modelTimeout?: { firstChunkMs: number; chunkMs: number }
}

let deps: AgentDeps | null = null

export function initAgent(d: AgentDeps): void {
  deps = d
  mkdirSync(d.storageDir, { recursive: true })
  purgeLegacySessions(d.storageDir)
}

/** 旧版 AiChatMessage（thinking/toolCall）与 UIMessage 不兼容：启动时直接清空旧文件 */
function purgeLegacySessions(dir: string): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        messages?: Array<{ parts?: Array<{ type?: string }> }>
      }
      const legacy = (raw.messages ?? []).some((m) =>
        (m.parts ?? []).some((p) => p.type === 'thinking' || p.type === 'toolCall')
      )
      if (legacy) rmSync(path, { force: true })
    } catch {
      rmSync(path, { force: true })
    }
  }
}

function requireDeps(): AgentDeps {
  if (!deps) throw new Error('agent not initialized: call initAgent() first')
  return deps
}

/* ---------------- 会话存储 ---------------- */

export interface AgentSessionRecord {
  id: string
  title: string
  /** 上次生成标题时的用户消息数（engine 据此决定何时刷新标题） */
  titledAt: number
  createdAt: number
  updatedAt: number
  messages: AiUIMessage[]
  contextSummary?: ContextSummary
}

/** 进行中回合：done 置位后本会话可开启新回合 */
interface Turn {
  id: string
  controller: AbortController
  done: boolean
  settled: Promise<void>
  settle: () => void
  contextCompressed: boolean
  contextSettings: AiContextSettings
  modelKey: string
  model?: LanguageModel
  contextUsage?: AiContextUsage
  finishReason?: string
}

/**
 * 同会话资源锁队列（按 key 分道）。SDK 同一步用 Promise.all 同时调用 execute，
 * enqueue 顺序 = map 顺序 = 模型 tool call / UI 卡片顺序 —— 同键据此保序，无键直行。
 * 同一主机的文件读写与连接生命周期共用 host:<id>，因此不会与 connect 的拆链重拨竞态。
 */
class ToolSerialQueue {
  private tails = new Map<string, Promise<void>>()
  run<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn()
    const tail = this.tails.get(key) ?? Promise.resolve()
    const next = tail.then(fn, fn)
    const gap = next.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(key, gap)
    // 链尾自清：排空后不保留该 key（会话长期存活，避免 Map 无界增长）
    void gap.then(() => {
      if (this.tails.get(key) === gap) this.tails.delete(key)
    })
    return next
  }
}

interface Session extends AgentSessionRecord {
  agent: ToolLoopAgent | null
  turn: Turn | null
  toolQueue: ToolSerialQueue
}

const sessions = new Map<string, Session>()

const sessionPath = (id: string): string => join(requireDeps().storageDir, `${id}.json`)

function readRecord(path: string): AgentSessionRecord | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AgentSessionRecord
  } catch {
    return null
  }
}

function persist(s: Session): void {
  // 删除会话后，迟到的回合收尾不得重新创建文件。
  if (sessions.get(s.id) !== s) return
  s.updatedAt = Date.now()
  const { id, title, titledAt, createdAt, updatedAt, messages, contextSummary } = s
  const p = sessionPath(s.id)
  writeFileSync(
    `${p}.tmp`,
    JSON.stringify({ id, title, titledAt, createdAt, updatedAt, messages, contextSummary })
  )
  renameSync(`${p}.tmp`, p)
}

function toSummary(s: AgentSessionRecord): AiSessionSummary {
  return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt }
}

/** 取运行中会话；不存在则从磁盘恢复（重启/切换会话后懒加载） */
function ensureSession(id: string): Session {
  let s = sessions.get(id)
  if (s) return s
  const record = readRecord(sessionPath(id))
  if (!record) throw new Error(`AI session not found: ${id}`)
  s = { ...record, agent: null, turn: null, toolQueue: new ToolSerialQueue() }
  sessions.set(id, s)
  return s
}

export function createAgentSession(): AiSessionSummary {
  const now = Date.now()
  const s: Session = {
    id: randomUUID(),
    title: '',
    titledAt: 0,
    createdAt: now,
    updatedAt: now,
    messages: [],
    agent: null,
    turn: null,
    toolQueue: new ToolSerialQueue()
  }
  sessions.set(s.id, s)
  persist(s)
  return toSummary(s)
}

export function listAgentSessions(): AiSessionSummary[] {
  const dir = requireDeps().storageDir
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => sessions.get(n.slice(0, -5)) ?? readRecord(join(dir, n)))
    .filter((r): r is AgentSessionRecord => r !== null)
    .map(toSummary)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function deleteAgentSession(id: string): void {
  abortTurn(id)
  sessions.delete(id)
  rmSync(sessionPath(id), { force: true })
}

export function getAgentSession(id: string): AgentSessionRecord {
  return ensureSession(id)
}

export function getAgentTurnId(id: string): string | undefined {
  return ensureSession(id).turn?.id
}

export function setAgentTitle(id: string, title: string): void {
  const s = ensureSession(id)
  s.title = title
  s.titledAt = s.messages.filter((m) => m.role === 'user').length
  persist(s)
}

export function abortTurn(sessionId: string, turnId?: string): void {
  const turn = sessions.get(sessionId)?.turn
  if (turn && !turn.done && (!turnId || turn.id === turnId)) turn.controller.abort()
}

/** 取消生成或待审批回合；确认落盘后再允许前端开启下一轮。 */
export async function cancelAgentTurn(sessionId: string, turnId?: string): Promise<AiUIMessage[]> {
  const s = ensureSession(sessionId)
  const turn = s.turn
  if (turnId && turn && turn.id !== turnId) return s.messages
  if (turn && !turn.done) {
    turn.controller.abort()
    await turn.settled
  } else if (s.messages.length) {
    finalize(s, s.messages, undefined, true)
  }
  return s.messages
}

/* ---------------- agent 构建 ---------------- */

/** 单回合步数上限：ops 场景一轮可能含多次 execute/poll，给足余量 */
const MAX_STEPS = 50

/** 序列化为单行紧凑文本并截断（日志条目单行展示） */
function forLog(v: unknown, max = 4000): string {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v))
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function reportContext(s: Session, turn: Turn, usage: AiContextUsage): void {
  if (turn.done || sessions.get(s.id) !== s) return
  turn.contextUsage = usage
  requireDeps().onContextUsage?.(s.id, turn.id, usage)
}

function toolSetFor(s: Session): ToolSet {
  return Object.fromEntries(
    requireDeps().tools.map((t) => [
      t.name,
      tool<unknown, unknown, Record<string, unknown>>({
        description: t.description ?? '',
        inputSchema: t.parameters as ZodType<unknown>,
        // 经会话队列串行：同一步多 tool 按卡片顺序执行，避免同路径读写删竞态
        execute: (input, { toolCallId, abortSignal }) =>
          s.toolQueue.run(t.lockKey?.(input) ?? null, async () => {
            if (abortSignal?.aborted) {
              const err = new Error('Interrupted')
              err.name = 'AbortError'
              throw err
            }
            return t.handler(input, { sessionId: s.id, toolCallId, signal: abortSignal })
          })
      })
    ])
  )
}

function agentFor(s: Session): ToolLoopAgent {
  if (s.agent) return s.agent
  const d = requireDeps()
  const instructions = typeof d.instructions === 'function' ? d.instructions() : d.instructions
  const toolTokens = estimateTokens(
    d.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toJSONSchema(t.parameters, { unrepresentable: 'any', io: 'input' })
    }))
  )
  s.agent = new ToolLoopAgent({
    model: d.getModel(),
    instructions,
    tools: toolSetFor(s),
    stopWhen: stepCountIs(MAX_STEPS),
    timeout: d.modelTimeout ?? { firstChunkMs: 120_000, chunkMs: 90_000 },
    // 每一步重新检查：工具循环也可能在单轮内填满窗口。
    prepareStep: async ({ messages, stepNumber }) => {
      const instructions = typeof d.instructions === 'function' ? d.instructions() : d.instructions
      const promptTokens = toolTokens + estimateTokens(instructions)
      const turn = s.turn!
      const { contextWindow, autoCompress } = turn.contextSettings
      const budget = Math.floor(contextWindow * 0.75) - promptTokens
      const usage: AiContextUsage = {
        modelKey: turn.modelKey,
        contextWindow,
        inputTokens: promptTokens + estimateTokens(messages),
        source: 'estimate',
        phase: 'ready'
      }
      reportContext(s, turn, usage)
      if (budget < 512)
        throw new Error(
          'Configured context window is too small for the agent tools. / 配置的上下文窗口不足以容纳工具定义，请检查模型窗口设置。'
        )
      const fitted = await compactContext({
        messages,
        budget,
        autoCompress,
        cached: stepNumber === 0 ? s.contextSummary : undefined,
        signal: turn.controller.signal,
        summarize: async (transcript, previous) => {
          reportContext(s, turn, { ...usage, phase: 'compressing' })
          const result = await generateText({
            model: turn.model ?? d.getModel(),
            system: SUMMARY_INSTRUCTIONS,
            prompt: `Previous summary:\n${previous}\n\nNext transcript fragment (may continue across fragments):\n${transcript}`,
            abortSignal: turn.controller.signal,
            timeout: 120_000,
            maxRetries: 0,
            maxOutputTokens: Math.max(128, Math.min(2048, Math.floor(budget * 0.05)))
          })
          if (result.finishReason === 'length')
            throw new Error(
              'Context summary was truncated; retry or shorten the conversation. / 上下文摘要被截断，请重试或缩短对话。'
            )
          return result.text
        }
      })
      reportContext(s, turn, {
        ...usage,
        inputTokens: promptTokens + estimateTokens(fitted.messages)
      })
      if (fitted.compressed) turn.contextCompressed = true
      if (stepNumber === 0 && fitted.summary) {
        s.contextSummary = fitted.summary
        persist(s)
      }
      return { messages: fitted.messages, instructions }
    },
    toolApproval: ({ toolCall }) => d.gate?.(s.id, toolCall) ?? 'not-applicable',
    // 每次调用重新解析模型：BYOK 绑定/密钥变化下一回合即时生效
    prepareCall: (call) => ({
      ...call,
      model: s.turn?.model ?? d.getModel(),
      maxOutputTokens: Math.min(8192, Math.floor(s.turn!.contextSettings.contextWindow * 0.15))
    })
  })
  return s.agent
}

/* ---------------- 回合执行 ---------------- */

/**
 * 发起回合：messages 为渲染层 Chat 的完整历史（末尾为新用户消息，或含审批响应的 assistant 消息）。
 * 立即持久化输入，返回本回合的 UI 流片流（单消费者）；收尾（onEnd）持久化最终消息。
 */
export function startTurn(
  sessionId: string,
  messages: AiUIMessage[],
  turnId: string = randomUUID()
): ReadableStream<UIMessageChunk> {
  const s = ensureSession(sessionId)
  if (s.turn && !s.turn.done) throw new Error('session is busy: a turn is already running')
  if (messages.at(-1)?.role === 'assistant' && s.messages.at(-1)?.metadata?.interrupted) {
    throw new Error('Interrupted turn requires a new user message')
  }
  const interrupted = new Map(
    s.messages.filter((m) => m.metadata?.interrupted).map((m) => [m.id, m])
  )
  s.messages = messages.map((m) => interrupted.get(m.id) ?? m)
  persist(s)
  let settle!: () => void
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  const turn: Turn = {
    id: turnId,
    controller: new AbortController(),
    done: false,
    settled,
    settle,
    contextCompressed: false,
    modelKey: requireDeps().getModelKey?.() ?? '',
    contextSettings: requireDeps().getContextSettings?.() ?? DEFAULT_CONTEXT_SETTINGS
  }
  s.turn = turn
  return new ReadableStream<UIMessageChunk>({
    start: (ctrl) =>
      runTurn(s, turn, (chunk) => {
        if (!chunk) {
          turn.done = true
          turn.settle()
        }
        chunk ? ctrl.enqueue(chunk) : ctrl.close()
      })
  })
}

async function runTurn(
  s: Session,
  turn: Turn,
  push: (chunk: UIMessageChunk | null) => void
): Promise<void> {
  const d = requireDeps()
  const isContinuation = s.messages.at(-1)?.role === 'assistant'
  let error: string | undefined
  try {
    // 模型、窗口和统计标识在回合开始时一起固定；设置变更下一轮生效。
    turn.model = d.getModel()
    const agent = agentFor(s)
    // 元数据不会被 SDK 转为模型输入：显式插入中断边界，避免将旧任务当成待办。
    const modelHistory = s.messages.map((m): AiUIMessage =>
      m.metadata?.interrupted
        ? {
            ...m,
            parts: [
              ...m.parts,
              {
                type: 'text',
                text: '[The user interrupted this turn. Do not resume its unfinished task unless the user explicitly asks to continue. Follow the latest user request. Already-started background commands may still be running; interruption does not mean rollback or success.]'
              }
            ]
          }
        : m
    )
    const history = await convertToModelMessages(modelHistory, {
      tools: agent.tools,
      ignoreIncompleteToolCalls: true
    })
    const result = await agent.stream({
      // 思维链只保留最后一条消息（审批续跑需回传同回合 reasoning），历史思维链剔除
      messages: pruneMessages({ messages: history, reasoning: 'before-last-message' }),
      abortSignal: turn.controller.signal,
      onStepFinish: ({ finishReason, usage, stepNumber }) => {
        if (turn.done) return
        if (
          turn.contextUsage &&
          typeof usage.inputTokens === 'number' &&
          Number.isFinite(usage.inputTokens) &&
          usage.inputTokens >= 0
        ) {
          reportContext(s, turn, {
            ...turn.contextUsage,
            inputTokens: usage.inputTokens,
            source: 'provider',
            phase: 'ready'
          })
        }
        turn.finishReason =
          stepNumber + 1 >= MAX_STEPS && finishReason === 'tool-calls' ? 'step-limit' : finishReason
        d.onLog?.(
          `Agent step ${stepNumber + 1}: finish=${finishReason}, inputTokens=${usage.inputTokens}, outputTokens=${usage.outputTokens}`
        )
      },
      onToolExecutionStart: ({ toolCall }) =>
        d.onLog?.(`Tool ${toolCall.toolName} input: ${forLog(toolCall.input)}`),
      onToolExecutionEnd: ({ toolCall, toolOutput }) =>
        d.onLog?.(
          `Tool ${toolCall.toolName} ${toolOutput.type === 'tool-error' ? `failed: ${errorMessage(toolOutput.error)}` : `output: ${forLog(toolOutput.output)}`}`
        )
    })
    const ui = toUIMessageStream<ToolSet, AiUIMessage>({
      stream: abortableStream(result.stream, turn.controller.signal, { type: 'abort' }),
      tools: agent.tools,
      originalMessages: s.messages,
      generateMessageId: randomUUID,
      messageMetadata: ({ part }) => {
        if (part.type === 'abort' && !turn.controller.signal.aborted)
          error = part.reason ?? 'Model response timed out or was interrupted'
        return part.type === 'start' && !isContinuation ? { createdAt: Date.now() } : undefined
      },
      onError: (err) => (error = errorMessage(err)),
      onEnd: ({ messages }) => finalize(s, messages, error, turn.controller.signal.aborted, turn)
    })
    for await (const chunk of ui) push(chunk)
  } catch (err) {
    // 流建立前失败（模型未配置/历史校验失败）：以流内错误告知渲染层，输入已持久化
    const message = turn.controller.signal.aborted ? undefined : errorMessage(err)
    if (message) push({ type: 'error', errorText: message })
    else push({ type: 'abort' })
    finalize(s, s.messages, message, turn.controller.signal.aborted, turn)
  } finally {
    push(null)
  }
}

/** 回合收尾：中断/出错后仍在执行态的工具卡标记中断；回合错误并入错误工具卡或写消息元数据；落盘 */
function finalize(
  s: Session,
  messages: AiUIMessage[],
  error: string | undefined,
  interrupted = false,
  turn?: Turn
): void {
  if (turn?.contextUsage) reportContext(s, turn, { ...turn.contextUsage, phase: 'ready' })
  let last = messages.at(-1)
  if (last?.role !== 'assistant' && (error || interrupted)) {
    last = { id: randomUUID(), role: 'assistant', parts: [], metadata: { createdAt: Date.now() } }
    messages = [...messages, last]
  }
  if (last?.role === 'assistant') {
    last.parts = last.parts.map((p) => {
      if (!isToolUIPart(p)) return p
      if (interrupted && (p.state === 'approval-requested' || p.state === 'approval-responded')) {
        return {
          ...p,
          state: 'output-denied',
          approval: { ...p.approval, approved: false, reason: 'User interrupted this turn' }
        }
      }
      return p.state === 'input-streaming' || p.state === 'input-available'
        ? { ...p, state: 'output-error', input: p.input, errorText: 'Interrupted' }
        : p
    })
    last.metadata = {
      createdAt: Date.now(),
      ...last.metadata,
      ...(interrupted ? { interrupted: true } : {}),
      ...(turn?.contextCompressed ? { contextCompressed: true } : {}),
      ...(turn?.contextUsage ? { contextUsage: turn.contextUsage } : {}),
      ...(turn?.finishReason ? { finishReason: turn.finishReason } : {})
    }
    if (error) {
      // 工具失败后模型未能恢复时，回合错误并入最后一张错误工具卡（同文案去重），
      // 不写 metadata，避免卡片 + 底部红框重复展示；无错误卡（纯模型/流失败）才落 metadata
      let target = -1
      let same = false
      for (let i = last.parts.length - 1; i >= 0; i--) {
        const p = last.parts[i]
        if (isToolUIPart(p) && p.state === 'output-error') {
          target = i
          same = p.errorText === error
          break
        }
      }
      if (target < 0) {
        last.metadata = { ...last.metadata, error }
      } else if (!same) {
        last.parts = last.parts.map((p, i) => {
          if (i !== target || !isToolUIPart(p) || p.state !== 'output-error') return p
          return { ...p, errorText: p.errorText ? `${p.errorText}\n${error}` : error }
        })
      }
    }
  }
  s.messages = messages
  persist(s)
}
