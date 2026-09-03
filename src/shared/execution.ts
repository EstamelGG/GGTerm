/** Status and exitCode describe the background shell, never the foreground command. */
export type ExecutionStatus = 'starting' | 'running' | 'completed' | 'failed' | 'unknown'
export interface ExecutionSnapshot {
  executionId: string
  sessionId: string
  target: 'remote'
  hostId: string
  command: string
  status: ExecutionStatus
  output: string
  cursor: number
  truncated: boolean
  exitCode: number | null
  signal?: string
  error?: string
  needsInput: boolean
  sensitiveInput: boolean
  /**
   * 人工输入待办的收尾结果（随快照回给模型）：submitted = 用户已代填（值不可见）、
   * cancelled/expired = 用户放弃。工具调用会一直挂起到这里出现值为止。
   */
  humanInputOutcome?: HumanInputOutcome
  cancelRequested: boolean
  terminationRequested?: boolean
}
export interface ExecutionStart {
  target: 'remote'
  hostId: string
  command: string
}

/**
 * 人工输入请求（密码 / 验证码等敏感提示）：
 * 主进程在执行被交互式提示阻塞时发出，渲染层「需要输入」卡片承接。
 * 值由用户直接输入并经独立通道写入 PTY —— 不经模型、不进输出缓冲、不进日志、不落盘。
 * 注意它不是 execution:* 只读查看器 API 的一部分（查看器永不暴露 stdin）。
 */
export interface HumanInputRequest {
  sessionId: string
  executionId: string
  hostId: string
  /** 触发本次阻塞的命令（卡片上回显上下文） */
  command: string
  /** 终端尾部提示（已去 ANSI、已截断） */
  prompt: string
  /** 过期时间戳：到期未提交则自动终止该执行 */
  expiresAt: number
}

/** 人工输入待办的收尾方式 */
export type HumanInputOutcome = 'submitted' | 'cancelled' | 'expired'

export interface HumanInputResolved {
  executionId: string
  /** 归属 AI 会话：渲染层按会话过滤、主进程据此唤醒对应模型 */
  sessionId: string
  outcome: HumanInputOutcome
}
