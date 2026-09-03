import type { LinkPhase, ShellStatus } from '@shared/types'

/**
 * 链路/连接状态的视觉语义（唯一映射：状态点组件、顶部标签页、会话页 tabs 共用）。
 * 颜色语义与拓扑图一致：绿 = 已连接 / 琥珀 = 进行中 / 红 = 失败 / 灰 = 未连接或已断开。
 * 点形态：空心 = 没在连接；实心绿 = 已连接；黄点闪烁 = 尝试连接中；红 = 失败。
 */

/** 状态点视觉（StateDot 组件的入参；linkStateDot / shellStateDot / solidDot 的产物） */
export interface StateDotVisual {
  /** 状态色（css color 值） */
  color: string
  /** false = 空心点（没在连接） */
  filled: boolean
  /** 呼吸动画（尝试连接中） */
  pulsing: boolean
}

/** 名称前状态点的悬停文案 i18n key（undefined = 本机从未连接过，空心点） */
export type LinkStateLabelKey =
  | 'conn.state.none'
  | 'conn.state.connecting'
  | 'conn.state.reconnecting'
  | 'conn.state.connected'
  | 'conn.state.offline'
  | 'conn.state.closed'

export function linkStateColor(phase: LinkPhase | undefined): string {
  switch (phase) {
    case 'connected':
      return 'var(--at-ok)'
    case 'connecting':
    case 'reconnecting':
      return 'var(--at-warn)'
    case 'offline':
      return 'var(--at-danger)'
    // undefined = 从未连接；'idle' = 链路被断开（含 AI 断开）
    default:
      return 'var(--at-muted)'
  }
}

/** 名称前状态点视觉：空心 = 没在连接；实心绿 = 已连接；黄点呼吸 = 尝试连接中；红 = 失败 */
export function linkStateDot(phase: LinkPhase | undefined): StateDotVisual {
  return {
    color: linkStateColor(phase),
    filled: phase !== undefined && phase !== 'idle',
    pulsing: phase === 'connecting' || phase === 'reconnecting'
  }
}

/** ShellStatus → 共用链路状态点映射。 */
export function shellStateDot(status: ShellStatus | undefined): StateDotVisual {
  return linkStateDot(
    status === 'error'
      ? 'offline'
      : status === 'connected' || status === 'connecting'
        ? status
        : undefined
  )
}

/** 常显实心点（无空心/闪烁语义的标记，如 AI tab 审批红点） */
export function solidDot(color: string): StateDotVisual {
  return { color, filled: true, pulsing: false }
}

export function linkStateLabelKey(phase: LinkPhase | undefined): LinkStateLabelKey {
  switch (phase) {
    case 'connected':
      return 'conn.state.connected'
    case 'connecting':
      return 'conn.state.connecting'
    case 'reconnecting':
      return 'conn.state.reconnecting'
    case 'offline':
      return 'conn.state.offline'
    case 'idle':
      return 'conn.state.closed'
    default:
      return 'conn.state.none'
  }
}
