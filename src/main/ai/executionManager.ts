import { randomUUID } from 'node:crypto'
import { stripAnsi } from '../ssh/shellBuffer'
import type {
  ExecutionSnapshot,
  ExecutionStart,
  ExecutionStatus,
  HumanInputOutcome,
  HumanInputRequest,
  HumanInputResolved
} from '../../shared/execution'

export interface ExecutionTransport {
  write(data: string): void
  interrupt(): void
  close(): void
}
export interface ExecutionEvents {
  data(data: string): void
  exit(code: number | null, signal?: string): void
  lost(reason: string): void
}
export type ExecutionConnector = (
  input: ExecutionStart,
  events: ExecutionEvents,
  signal?: AbortSignal
) => Promise<ExecutionTransport>

const MAX_OUTPUT = 128 * 1024
const MAX_ACTIVE = 16
const MAX_FINISHED_OUTPUT = 8 * 1024 * 1024
/** 人工输入超时：到期未提交即终止该执行，避免悬挂的等待 */
const HUMAN_INPUT_TTL_MS = 5 * 60 * 1000
/** 回显抹除用的掩码（人工提交的密码若被远端回显，替换为此串，永不进入输出缓冲） */
const REDACTED = '••••••••'
const finished = (status: ExecutionStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'unknown'

/** 「正在等输入」的三种提示特征：wait 判是否交回控制权、input 判是否回退到提示符行，共用同一套判据 */
const SENSITIVE_PROMPT_RE =
  /(?:password|passphrase|verification code|one.time (?:code|password)|密码|口令|验证码)[^\r\n]{0,100}[:：?？]\s*$/i
const YES_NO_PROMPT_RE =
  /(?:\[(?:y\/n|n\/y|yes\/no|no\/yes)\]|\((?:y\/n|n\/y|yes\/no|no\/yes)\))\s*[:：?？]?\s*$/i
const ASK_PROMPT_RE =
  /(?:\[[ynYN/]+\]|\([ynYN/]+\)|(?:enter|input|select|choose|请输入|请选择)[^\r\n]{0,100}[:：?？])\s*$/i
const SHELL_PROMPT_RE = /(?:^|[\r\n])[^\r\n]{0,200}[$#%>]\s*$/

/** 卡片展示用的提示行：终端尾部最后一行非空内容（已去 ANSI），最长 200 字符 */
function promptLine(output: string): string {
  const tail = stripAnsi(output).slice(-1000)
  const line =
    tail
      .split(/[\r\n]+/)
      .filter((l) => l.trim())
      .pop() ?? ''
  return line.trim().slice(-200)
}

/**
 * 追加输入的回传起点：缓冲末尾那一行若是等待中的提示（cmd prompt / 交互提问 / 口令提示），
 * 回退到该行行首，让本次响应带上提示符行（否则切片从行中间开始，卡片与模型只看到半行）；
 * 末尾不是提示（上一条命令仍在输出、或已以换行收尾）则维持写入时刻的末尾。
 */
function inputStart(task: Task): number {
  const nl = task.output.lastIndexOf('\n')
  const tail = stripAnsi(task.output.slice(nl + 1))
  const waiting =
    SENSITIVE_PROMPT_RE.test(tail) ||
    YES_NO_PROMPT_RE.test(tail) ||
    ASK_PROMPT_RE.test(tail) ||
    SHELL_PROMPT_RE.test(tail)
  return waiting ? task.offset + nl + 1 : task.offset + task.output.length
}

interface Task {
  view: Omit<ExecutionSnapshot, 'output' | 'cursor' | 'truncated'>
  output: string
  offset: number
  updatedAt: number
  promptAcknowledged: number
  transport?: ExecutionTransport
  listeners: Set<() => void>
  controller: AbortController
  /** 待人工输入的敏感提示（存在即代表 agent 不可代填，只能由渲染层卡片提交） */
  humanInput?: HumanInputRequest
  /** 人工输入超时定时器 */
  humanTimer?: ReturnType<typeof setTimeout>
  /** 人工提交过的值：出现即从输出中抹除，保证密码不进入模型上下文 */
  redact?: string
}

/** Owns processes independently of SDK requests, React mounts, and polling. */
export class ExecutionManager {
  private tasks = new Map<string, Task>()
  /** 会话级空闲回调：该会话无未完结执行时触发（登记时已空闲则立即触发） */
  private idleCallbacks = new Map<string, Set<() => void>>()
  onBackgroundFinish?: (snapshot: ExecutionSnapshot) => void
  /** 人工输入待办订阅：IPC 广播给渲染层、engine 唤起模型，各订阅一份 */
  private humanRequestSubs = new Set<(request: HumanInputRequest) => void>()
  private humanResolvedSubs = new Set<(info: HumanInputResolved) => void>()

  /** 订阅敏感提示待办（返回退订函数） */
  onHumanInputRequest(cb: (request: HumanInputRequest) => void): () => void {
    this.humanRequestSubs.add(cb)
    return () => this.humanRequestSubs.delete(cb)
  }

  /** 订阅待办收尾（提交/取消/超时，返回退订函数） */
  onHumanInputResolved(cb: (info: HumanInputResolved) => void): () => void {
    this.humanResolvedSubs.add(cb)
    return () => this.humanResolvedSubs.delete(cb)
  }

  constructor(private readonly connect: ExecutionConnector) {}

  onSessionIdle(sessionId: string, cb: () => void): void {
    const busy = [...this.tasks.values()].some(
      (t) => t.view.sessionId === sessionId && !finished(t.view.status)
    )
    if (!busy) {
      cb()
      return
    }
    const set = this.idleCallbacks.get(sessionId) ?? new Set<() => void>()
    set.add(cb)
    this.idleCallbacks.set(sessionId, set)
  }

  /** 会话任一执行完结后调用：已无未完结执行则冲刷空闲回调 */
  private flushIdle(sessionId: string): void {
    const set = this.idleCallbacks.get(sessionId)
    if (!set) return
    const busy = [...this.tasks.values()].some(
      (t) => t.view.sessionId === sessionId && !finished(t.view.status)
    )
    if (busy) return
    this.idleCallbacks.delete(sessionId)
    for (const cb of set) cb()
  }

  start(sessionId: string, input: ExecutionStart): string {
    if (!input.hostId) throw new Error('Remote execution requires hostId')
    if ([...this.tasks.values()].filter((t) => !finished(t.view.status)).length >= MAX_ACTIVE) {
      throw new Error(
        'Maximum concurrent executions reached; inspect existing tasks with execute list — they will NOT be terminated automatically'
      )
    }
    const id = randomUUID()
    const task: Task = {
      view: {
        ...input,
        executionId: id,
        sessionId,
        status: 'starting',
        exitCode: null,
        needsInput: false,
        sensitiveInput: false,
        cancelRequested: false,
        terminationRequested: false
      },
      output: '',
      offset: 0,
      updatedAt: Date.now(),
      promptAcknowledged: -1,
      listeners: new Set(),
      controller: new AbortController()
    }
    this.tasks.set(id, task)
    const end = (
      status: ExecutionStatus,
      code: number | null,
      signal?: string,
      error?: string
    ): void => {
      if (finished(task.view.status)) return
      task.view = {
        ...task.view,
        status,
        exitCode: code,
        signal,
        error,
        needsInput: false,
        sensitiveInput: false
      }
      // 待办期间执行结束（查看器终止 / 链路断开）：收起卡片，不留无法提交的输入框
      if (task.humanInput) this.settleHumanInput(task, 'cancelled')
      task.redact = undefined
      task.transport = undefined
      this.trimFinishedOutput()
      const waiting = task.listeners.size > 0
      for (const notify of [...task.listeners]) notify()
      if (!waiting) this.onBackgroundFinish?.(this.snapshot(sessionId, id))
      this.flushIdle(sessionId)
    }
    void this.connect(
      input,
      {
        data: (data) => {
          if (finished(task.view.status)) return
          // 人工提交的密码若被远端回显：写入缓冲前抹成掩码（模型只读到这里）
          const chunk = task.redact ? data.split(task.redact).join(REDACTED) : data
          task.output += chunk
          if (task.output.length > MAX_OUTPUT) {
            let drop = task.output.length - MAX_OUTPUT
            if (/^[\uDC00-\uDFFF]$/.test(task.output[drop])) drop++
            task.output = task.output.slice(drop)
            task.offset += drop
          }
          task.updatedAt = Date.now()
        },
        exit: (code, signal) => end('completed', code, signal),
        lost: (reason) => end('unknown', null, undefined, reason)
      },
      task.controller.signal
    )
      .then((transport) => {
        if (!finished(task.view.status)) {
          task.transport = transport
          task.view.status = 'running'
        }
        if (task.view.terminationRequested) transport.close()
      })
      .catch((error: unknown) => {
        end('failed', null, undefined, error instanceof Error ? error.message : String(error))
      })
    return id
  }

  /** Keep every session record; bound retained output instead of silently deleting old tasks. */
  private trimFinishedOutput(): void {
    const completed = [...this.tasks.values()].filter((task) => finished(task.view.status))
    let excess =
      completed.reduce((total, task) => total + task.output.length, 0) - MAX_FINISHED_OUTPUT
    for (const task of completed) {
      if (excess <= 0) break
      let drop = Math.min(excess, task.output.length)
      if (/^[\uDC00-\uDFFF]$/.test(task.output[drop])) drop++
      task.output = task.output.slice(drop)
      task.offset += drop
      excess -= drop
    }
  }

  private task(sessionId: string, id: string): Task {
    const task = this.tasks.get(id)
    if (!task || task.view.sessionId !== sessionId) {
      throw new Error(
        'Execution task not found or not owned by this AI session; PTY channels cannot be recovered after an app restart — do NOT rerun automatically'
      )
    }
    return task
  }

  snapshot(sessionId: string, id: string, cursor = 0, raw = false): ExecutionSnapshot {
    const task = this.task(sessionId, id)
    const end = task.offset + task.output.length
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > end)
      throw new Error('Invalid output cursor')
    const output = task.output.slice(Math.max(0, cursor - task.offset))
    return {
      ...task.view,
      output: raw ? output : stripAnsi(output),
      cursor: end,
      truncated: cursor < task.offset
    }
  }

  /** 按会话列出（可选 hostId 二次过滤 = 只看该会话在某主机下的执行） */
  list(sessionId: string, hostId?: string): ExecutionSnapshot[] {
    return [...this.tasks.values()]
      .filter((t) => t.view.sessionId === sessionId && (!hostId || t.view.hostId === hostId))
      .map((t) => ({ ...t.view, output: '', cursor: t.offset + t.output.length, truncated: false }))
  }

  /** 提交输入；返回本次输入的绝对输出起点（含等待中的提示符行，后续 wait 从此切片 = 只含本次命令相关的输出） */
  input(sessionId: string, id: string, data: string): number {
    const task = this.task(sessionId, id)
    if (!task.transport || task.view.status !== 'running' || task.view.terminationRequested)
      throw new Error('Execution channel not ready or already finished; input was not sent')
    if (task.view.sensitiveInput)
      throw new Error(
        'Sensitive input cannot be submitted through the Agent; the execution viewer is read-only — ask the user to submit it in the chat card'
      )
    const from = inputStart(task)
    task.transport.write(data)
    // 新鲜度基准仍是写入时刻的末尾：提示符行回退只影响回传起点，不能让 wait 立刻以为「有新输出」
    task.promptAcknowledged = task.offset + task.output.length
    task.view.needsInput = false
    task.view.sensitiveInput = false
    return from
  }

  cancel(sessionId: string, id: string): void {
    const task = this.task(sessionId, id)
    if (!task.transport || task.view.status !== 'running')
      throw new Error('Channel unavailable; cannot confirm interrupt — the task will NOT be rerun')
    task.transport.interrupt()
    task.view.cancelRequested = true
    // An interrupt request is not an exit and not a rollback.
  }

  /** Explicit termination closes the PTY, including one still being created; retains its record. */
  closeHost(hostId: string, sessionId: string): void {
    for (const task of this.tasks.values()) {
      if (
        task.view.target === 'remote' &&
        task.view.hostId === hostId &&
        task.view.sessionId === sessionId &&
        !finished(task.view.status)
      ) {
        this.close(task.view.sessionId, task.view.executionId)
      }
    }
  }

  close(sessionId: string, id: string): void {
    const task = this.task(sessionId, id)
    if (task.view.terminationRequested) return
    task.transport?.close()
    task.controller.abort()
    task.view.terminationRequested = true
    task.view.cancelRequested = true
  }

  /**
   * 人工提交敏感输入（仅渲染层「需要输入」卡片调用，agent 无此通道）。
   * 值直接写入 PTY：不进日志、不落盘、不返回给模型；若远端回显则被抹成掩码。
   * 提交后待办收尾（卡片收起），命令继续跑，完结时经 onBackgroundFinish 唤醒模型。
   */
  submitHumanInput(sessionId: string, id: string, value: string): void {
    const task = this.task(sessionId, id)
    if (!task.humanInput) throw new Error('No pending human input request for this execution')
    if (!task.transport || task.view.status !== 'running' || task.view.terminationRequested)
      throw new Error('Execution channel not ready or already finished; input was not sent')
    const secret = value.replace(/[\r\n]+$/, '')
    // 先登记再写入：回显先于/紧跟写入返回，登记晚了就漏进输出缓冲。
    // 短值（如 "y"）不登记：逐字替换会把正常输出也抹花，而敏感提示本身不回显。
    if (secret.trim().length >= 6) task.redact = secret
    task.transport.write(`${secret}\n`)
    task.promptAcknowledged = task.offset + task.output.length
    this.settleHumanInput(task, 'submitted')
  }

  /** 卡片上选择「终止命令」：先终止（让等待者拿到 terminationRequested），再收尾为 cancelled */
  cancelHumanInput(sessionId: string, id: string): void {
    const task = this.task(sessionId, id)
    if (!task.humanInput) throw new Error('No pending human input request for this execution')
    this.close(sessionId, id)
    this.settleHumanInput(task, 'cancelled')
  }

  /** 未收尾的人工输入待办（渲染层启动/刷新后据此恢复卡片） */
  pendingHumanInput(sessionId?: string): HumanInputRequest[] {
    return [...this.tasks.values()].flatMap((t) =>
      t.humanInput && (!sessionId || t.view.sessionId === sessionId) ? [t.humanInput] : []
    )
  }

  /** 敏感提示 → 建立人工输入待办并通知渲染层（重复检测只刷新提示与超时，不产生第二条待办） */
  private requestHumanInput(task: Task, output: string): void {
    const request: HumanInputRequest = {
      sessionId: task.view.sessionId,
      executionId: task.view.executionId,
      hostId: task.view.hostId,
      command: task.view.command,
      prompt: promptLine(output),
      expiresAt: Date.now() + HUMAN_INPUT_TTL_MS
    }
    // 已存在待办：只刷新提示文本，不重置超时（TTL 是硬上限，避免无人值守时无限等待）
    if (task.humanInput) {
      task.humanInput = { ...request, expiresAt: task.humanInput.expiresAt }
      for (const notify of [...this.humanRequestSubs]) notify(task.humanInput)
      return
    }
    task.humanInput = request
    task.humanTimer = setTimeout(() => this.expireHumanInput(request), HUMAN_INPUT_TTL_MS)
    // 待办不应阻止进程退出（仅内存态，重开应用即失效）
    task.humanTimer.unref?.()
    for (const notify of [...this.humanRequestSubs]) notify(request)
  }

  /** 超时未提交：收尾为 expired 并终止该执行（先终止：等待者拿到 terminationRequested 再被唤醒） */
  private expireHumanInput(request: HumanInputRequest): void {
    const task = this.tasks.get(request.executionId)
    if (!task?.humanInput) return
    this.close(request.sessionId, request.executionId)
    this.settleHumanInput(task, 'expired')
  }

  /** 待办收尾：清定时器与待办态，唤醒挂起的工具调用，并通知渲染层收起卡片 */
  private settleHumanInput(task: Task, outcome: HumanInputOutcome): void {
    if (task.humanTimer) {
      clearTimeout(task.humanTimer)
      task.humanTimer = undefined
    }
    task.humanInput = undefined
    if (!finished(task.view.status)) {
      task.view.needsInput = false
      task.view.sensitiveInput = false
    }
    // 收尾结果随快照回给模型：submitted = 用户已代填（值不可见），cancelled/expired = 放弃
    task.view.humanInputOutcome = outcome
    // 唤醒挂起的工具调用（对照审批卡：响应到位后 SDK 继续同一轮，不新增会话消息）
    for (const notify of [...task.listeners]) notify()
    for (const notify of [...this.humanResolvedSubs])
      notify({
        executionId: task.view.executionId,
        sessionId: task.view.sessionId,
        outcome
      })
  }

  /** Output is collected continuously; only completion, a prompt, or a bounded wait wakes the model. */
  wait(
    sessionId: string,
    id: string,
    cursor = 0,
    waitMs = 60_000,
    signal?: AbortSignal
  ): Promise<ExecutionSnapshot> {
    const task = this.task(sessionId, id)
    this.snapshot(sessionId, id, cursor) // Validate before installing listeners.
    if (finished(task.view.status) || signal?.aborted || waitMs === 0) {
      return Promise.resolve(this.snapshot(sessionId, id, cursor))
    }
    return new Promise((resolve) => {
      let done = false
      const complete = (): void => {
        if (done) return
        done = true
        clearInterval(check)
        clearTimeout(deadline)
        task.listeners.delete(complete)
        signal?.removeEventListener('abort', complete)
        resolve(this.snapshot(sessionId, id, cursor))
      }
      const check = setInterval(() => {
        const tail = stripAnsi(task.output).slice(-1000).trimEnd()
        const fresh = task.offset + task.output.length > task.promptAcknowledged
        const sensitive = SENSITIVE_PROMPT_RE.test(tail) && !YES_NO_PROMPT_RE.test(tail)
        const prompt = sensitive || YES_NO_PROMPT_RE.test(tail) || ASK_PROMPT_RE.test(tail)
        // Ordinary shell prompts are hints to inspect output, never proof of command success.
        const shellPrompt = SHELL_PROMPT_RE.test(tail)
        if (fresh && (prompt || shellPrompt) && Date.now() - task.updatedAt >= 1000) {
          task.view.needsInput = true
          task.view.sensitiveInput = sensitive
          if (sensitive) {
            // 密码/验证码等敏感提示：agent 不可代填（input 会被拒），改由人工输入卡片承接。
            // 关键：**不 complete()** —— 工具调用保持挂起（对照审批卡的等待语义），
            // 由 submit/cancel/expire 收尾时经 listeners 交回模型，模型侧零消息注入。
            this.requestHumanInput(task, task.output)
          } else {
            complete()
          }
        }
      }, 5000)
      // 人工输入待办期间不按 deadline 返回：deadline 只是「最长等一次」的软上限，
      // 不应打断人工环节；待办收尾时 settleHumanInput 会主动唤醒本等待者
      const deadline = setTimeout(
        () => {
          if (!task.humanInput) complete()
        },
        Math.max(0, Math.min(60_000, waitMs))
      )
      task.listeners.add(complete)
      signal?.addEventListener('abort', complete, { once: true })
    })
  }
}
