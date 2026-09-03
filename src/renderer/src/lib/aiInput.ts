import type { TFunction } from 'i18next'
import type { HostConnection, LinkPhase } from '@shared/types'

/**
 * AI 输入的「提示词层」：@主机引用与斜杠命令在 send 前展开/拼接，全部走正常对话流。
 * 动作由 agent 已有工具完成 —— 零主进程改动，上下文不断裂。
 * UI 中的消息保持用户输入的原文；只有发给 LLM 的 payload 经这里变换。
 */

/** @ 提及解析所需的主机上下文（连接态取全局链路镜像） */
export interface MentionContext {
  conn: HostConnection
  phase?: LinkPhase
}

/** 斜杠命令 id（i18n：ai.cmd.<id>Label / <id>Desc / <id>Template） */
export const SLASH_COMMANDS = ['connect', 'status'] as const
export type SlashCommandId = (typeof SLASH_COMMANDS)[number]

/**
 * 光标处正在输入的 @token（不含 @）。
 * 规则：光标前最近的 @，且 @ 到光标之间无空白 —— 选中后插入 "@名称 "（带尾空格）即自动关闭。
 */
export function activeMention(text: string, caret: number): string | undefined {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return undefined
  const token = before.slice(at + 1)
  return /\s/.test(token) ? undefined : token
}

/** 输入整体处于命令形态（以 / 开头且尚未出现空格）时返回命令 token（不含 /） */
export function activeCommandToken(text: string): string | undefined {
  if (!text.startsWith('/')) return undefined
  const rest = text.slice(1)
  return /\s/.test(rest) ? undefined : rest
}

/** 提取文本中全部 @token（去重保序） */
function mentionTokens(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/@([^\s@]+)/g)) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

function authLabel(auth: HostConnection['authType']): string {
  switch (auth) {
    case 'password':
      return '密码认证'
    case 'privateKey':
      return '密钥认证'
    default:
      return '手动认证'
  }
}

function phaseLabel(phase: LinkPhase | undefined): string {
  switch (phase) {
    case 'connected':
      return '当前已连接'
    case 'connecting':
      return '连接中'
    case 'reconnecting':
      return '重连中'
    case 'offline':
      return '连接失败'
    case 'idle':
      return '已断开'
    default:
      return '当前未连接'
  }
}

/** 命令模板（提示词层核心：展开为自然语言指令，由 agent 工具完成动作） */
export function commandTemplate(id: SlashCommandId, args: string, t: TFunction): string {
  if (id === 'connect') {
    // 参数里的 @ 引用剥成裸名称（与提及解析共用同一套名称匹配）
    const name = args.replace(/@/g, '').trim()
    return name ? t('ai.cmd.connectTemplate', { name }) : t('ai.cmd.connectNoArg')
  }
  return t('ai.cmd.statusTemplate')
}

/**
 * 组装发给 LLM 的 payload：
 *   ① 行首 /命令 展开为模板文本（参数保留）；
 *   ② @提及解析成资产上下文块追加在末尾（名称精确匹配、大小写不敏感；匹配不上的按普通文本放行）。
 */
export function buildPayload(raw: string, mentions: MentionContext[], t: TFunction): string {
  let body = raw

  const cmd = raw.match(/^\/(\w+)\s*([\s\S]*)$/)
  if (cmd && (SLASH_COMMANDS as readonly string[]).includes(cmd[1])) {
    body = commandTemplate(cmd[1] as SlashCommandId, cmd[2], t)
  }

  const byName = new Map(mentions.map((m) => [m.conn.name.toLowerCase(), m]))
  const resolved = mentionTokens(raw)
    .map((tok) => byName.get(tok.toLowerCase()))
    .filter((m): m is MentionContext => m !== undefined)
  if (resolved.length === 0) return body

  const lines = resolved.map(({ conn, phase }) => {
    let line = `- ${conn.name}：${conn.host}:${conn.port}，用户 ${conn.username}，${authLabel(
      conn.authType
    )}，${phaseLabel(phase)}`
    if (conn.note?.purpose) line += `。备注：${conn.note.purpose}`
    return line
  })
  return `${body}\n\n[用户提到的主机资产]\n${lines.join('\n')}`
}
