import { generateText } from 'ai'
import type { AiConfig } from '../../shared/types'
import { createChatModel } from './provider'

/**
 * 命令意图判定门（安全 → 放行 / 危险 → 人工审批 / 模糊 → LLM 判定转人工）+ 三档审批偏好
 * + SFTP/会话简化门。纯判定：返回动作，不做 IPC / 挂起（挂起由 agent.ts 的审批状态机负责）。
 */

export type GateAction = 'direct' | 'confirm' | 'deny'

export type GateLevel =
  'whitelist' | 'blacklist' | 'gray' | 'strict' | 'sftp' | 'session' | 'config'

export interface GateDecision {
  action: GateAction
  level: GateLevel
  reason: string
}

/* ---------------- 静态规则 ---------------- */

/**
 * 三档意图判定：
 *   安全（只读检视，管道各段均须安全）→ 直接放行；
 *   危险（毁灭性/不可逆/提权）→ 直接人工审批（AI 无权放行）；
 *   其余模糊命令 → LLM 子 agent 判定（safe 自动执行 / unsafe 转人工，永不自动拦截）。
 */

/** 安全命令（只读检视）；top/less/more 交互式 TUI 会挂住后台 shell，不列入 */
const SAFE_CMDS =
  'ls|cat|head|tail|df|du|ps|uptime|uname|who|whoami|id|pwd|echo|date|free|hostname|' +
  'ss|netstat|ip|route|env|printenv|stat|file|wc|grep|find|locate|which|type|whereis|tree|' +
  'lsof|lsblk|blkid|dmesg|last|pstree|history'

const SAFE_RE = new RegExp(`^(?:${SAFE_CMDS})(?:\\s|$)`)

/** 已知只读形态（按子命令白名单，而非整命令前缀） */
const SAFE_FORMS: RegExp[] = [
  /^journalctl(?:\s|$)/,
  /^docker\s+(?:ps|images|inspect|logs|stats|top|version|info)(?:\s|$)/,
  /^git\s+(?:status|log|diff|show|branch|remote|tag|blame)(?:\s|$)/,
  /^systemctl\s+(?:status|is-active|is-enabled|show|list-units|list-unit-files|list-timers)(?:\s|$)/,
  /^kill\s+-0(?:\s|$)/
]

/** 危险命令（毁灭性/不可逆/提权/递归破坏）：跳过 AI 直接人工审批 */
const CRITICAL: RegExp[] = [
  /\brm\b/,
  /\brmdir\b/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\bmkfs\./,
  /\bfdisk\b/,
  /\bparted\b/,
  /\bchmod\b[^\n]*-[a-zA-Z]*R/,
  /\bchown\b[^\n]*-[a-zA-Z]*R/,
  /\breboot\b/,
  /\bshutdown\b/,
  /\bpoweroff\b/,
  /\bhalt\b/,
  /\binit\s+[0-6]\b/,
  /\bsudo\b/,
  /\bsu\b/,
  /\buseradd\b/,
  /\buserdel\b/,
  /\busermod\b/,
  /\bgroupadd\b/,
  /\bgroupdel\b/,
  /\bgroupmod\b/,
  /\bpasswd\b/,
  /\bfind\b[^\n]*(?:-delete|-exec)/,
  /\|\s*(?:\/bin\/)?(?:ba|z|k|da)?sh\b/,
  /\beval\b/,
  /:\(\)\s*\{/
]

function isCritical(command: string): boolean {
  return CRITICAL.some((re) => re.test(command))
}

/** 安全判定：无重定向/命令替换/多命令元字符，且管道各段均为安全命令或已知只读形态 */
function isSafe(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || /[;&<>`$\\\n]/.test(trimmed)) return false
  return trimmed.split('|').every((seg) => {
    const s = seg.trim()
    return SAFE_FORMS.some((re) => re.test(s)) || SAFE_RE.test(s)
  })
}

/* ---------------- 灰区子 agent ---------------- */

interface SubVerdict {
  verdict: 'safe' | 'unsafe'
  reason: string
}

/** 审批 reason 的 UI 展示语言（跟随应用语言；调用方经 resolveLocale 传入，保持本模块不依赖 electron） */
type ReasonLocale = 'en' | 'zh-CN'

const REASON_LANG: Record<ReasonLocale, string> = { en: 'English', 'zh-CN': 'Chinese' }

const subSystem = (locale: ReasonLocale): string =>
  'You are a command-safety judge. Analyze the intent and potential consequences of the given command, ' +
  `and output exactly one JSON object: {"verdict":"safe|unsafe","reason":"<brief reason, in ${REASON_LANG[locale]} for UI display>"}. ` +
  'safe = read-only or clearly low-risk, proceed automatically; unsafe = has side effects, risks or is ambiguous, escalate to human approval.'

async function subAgentJudge(
  command: string,
  config: AiConfig,
  locale: ReasonLocale
): Promise<SubVerdict> {
  const fallback: SubVerdict = {
    verdict: 'unsafe',
    reason:
      locale === 'zh-CN'
        ? '子 agent 判定失败，转人工确认'
        : 'Sub-agent judge failed, escalating to human approval'
  }
  try {
    const model = createChatModel(config, 'judge')
    const res = await generateText({
      model,
      system: subSystem(locale),
      prompt: `Command: ${command}`,
      timeout: 60_000
    })
    const text = res.text ?? ''
    const match = /{[^}]*}/s.exec(text)
    if (!match) return fallback
    const parsed = JSON.parse(match[0]) as Partial<SubVerdict>
    if (parsed.verdict !== 'safe' && parsed.verdict !== 'unsafe') {
      return fallback
    }
    return { verdict: parsed.verdict, reason: parsed.reason || '' }
  } catch {
    return fallback
  }
}

/* ---------------- 判定入口 ---------------- */

export async function judgeCommand(
  command: string,
  config: AiConfig,
  locale: ReasonLocale = 'en'
): Promise<GateDecision> {
  if (config.approvalLevel === 'relaxed') {
    return { action: 'direct', level: 'whitelist', reason: '' }
  }
  // 危险命令先于安全判定：毁灭性/提权形态（含 find -delete 等参数级危险）无权自动放行
  if (isCritical(command)) {
    return {
      action: 'confirm',
      level: 'blacklist',
      reason: 'Critical command requires manual approval'
    }
  }
  if (isSafe(command)) {
    return { action: 'direct', level: 'whitelist', reason: '' }
  }
  // 严格模式跳过 AI：安全命令之外的其余全部人工审批
  if (config.approvalLevel === 'strict') {
    return {
      action: 'confirm',
      level: 'strict',
      reason: 'Strict mode: command requires manual approval'
    }
  }
  // 模糊命令 → AI 判定：safe 自动执行；unsafe 一律转人工审批（AI 永不自动拦截，人工拒绝后模型可改方案）
  const sub = await subAgentJudge(command, config, locale)
  return {
    action: sub.verdict === 'safe' ? 'direct' : 'confirm',
    level: 'gray',
    reason: sub.reason
  }
}

/** SFTP 写/删/改名：语义简单，无需子 agent；仅宽松模式直行。 */
export function judgeSftpWrite(config: AiConfig): GateDecision {
  if (config.approvalLevel === 'relaxed')
    return { action: 'direct', level: 'whitelist', reason: '' }
  return {
    action: 'confirm',
    level: 'sftp',
    reason: 'SFTP write/delete/rename requires confirmation'
  }
}

/** 断连/关 shell：可能中断正在运行的任务。 */
export function judgeSessionClose(config: AiConfig): GateDecision {
  if (config.approvalLevel === 'relaxed')
    return { action: 'direct', level: 'whitelist', reason: '' }
  return {
    action: 'confirm',
    level: 'session',
    reason: 'Disconnecting/closing a shell may interrupt running tasks'
  }
}

/** 连接/分组/凭据等配置结构变更：改变用户已有工作环境，非宽松模式一律确认。 */
export function judgeConfig(op: string, config: AiConfig): GateDecision {
  if (config.approvalLevel === 'relaxed')
    return { action: 'direct', level: 'whitelist', reason: '' }
  return {
    action: 'confirm',
    level: 'config',
    reason: `${op}: connection config change requires confirmation`
  }
}
