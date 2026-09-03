/** 应用偏好的数值约定（主进程夹紧与渲染层滑块共用同一份，避免两处漂移） */

/** UI 缩放百分比：5% 步进；默认 100% = 不缩放 */
export const UI_SCALE_STEP = 5
export const UI_SCALE_MIN = 80
export const UI_SCALE_MAX = 150
export const UI_SCALE_DEFAULT = 100

/** 夹紧到合法区间并吸附到 5% 网格（非法值 → 默认值） */
export function clampUiScale(percent: number): number {
  if (!Number.isFinite(percent)) return UI_SCALE_DEFAULT
  const snapped = Math.round(percent / UI_SCALE_STEP) * UI_SCALE_STEP
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, snapped))
}

/**
 * 终端字号（px）：菜单/快捷键每次一步、复位回默认值。
 * 主进程负责步进（写偏好 → 广播），渲染层负责夹紧与套用，故两边共用同一份。
 */
export const TERMINAL_FONT_SIZE_STEP = 1
export const TERMINAL_FONT_SIZE_MIN = 8
export const TERMINAL_FONT_SIZE_MAX = 24
export const TERMINAL_FONT_SIZE_DEFAULT = 12

/** 夹紧到 [min, max] 并取整（非法值 → 默认值） */
export function clampTerminalFontSize(px: number): number {
  if (!Number.isFinite(px)) return TERMINAL_FONT_SIZE_DEFAULT
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(px)))
}

/** 步进后的字号（delta = 0 表示复位到默认值）；越界自动夹紧 */
export function nextTerminalFontSize(cur: number, delta: number): number {
  const base = Number.isFinite(cur) ? cur : TERMINAL_FONT_SIZE_DEFAULT
  return clampTerminalFontSize(delta === 0 ? TERMINAL_FONT_SIZE_DEFAULT : base + delta)
}
