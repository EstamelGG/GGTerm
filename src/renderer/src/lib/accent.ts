import { clampUiScale } from '@shared/prefs'
import { applyTerminalUiScale } from '@/terminal/registry'

/** 偏好中的强调色应用到全局 CSS 变量（对照 Swift .tint(Theme.color(accentHex))） */
export function applyAccent(hex: string): void {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  const n = m ? parseInt(m[1], 16) : 0x37a563
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  const root = document.documentElement.style
  root.setProperty('--at-accent', `#${m ? m[1] : '37a563'}`)
  root.setProperty(
    '--at-accent-dim',
    `rgb(${Math.round(r * 0.78)} ${Math.round(g * 0.78)} ${Math.round(b * 0.78)})`
  )
  root.setProperty('--at-accent-rgb', `${r} ${g} ${b}`)
}

/**
 * 背景透明度（0–100）应用到全局 CSS 变量：
 *   100 = 设计默认层次（main.css 各表面色原样，窗口材质隐约透出）
 *     0 = 完全实色（表面 alpha 拉满，挡掉 vibrancy/亚克力底）
 * 中间值在「实 ↔ 透」轴上线性平移，层间相对关系保持不变。
 * 悬浮层（.glass）、--at-hover、文本与分隔线不参与缩放 —— 浮层/交互反馈始终可读。
 */
export function applyBgTransparency(percent: number): void {
  const t = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 100
  document.documentElement.style.setProperty('--at-surface-mix', String(t / 100))
}

/**
 * UI 缩放（百分比，5% 步进）：整体缩放应用界面 —— 页面缩放由主进程执行（启动时的 zoomFactor /
 * 落库经 prefs:set → webContents.setZoomFactor），这里只处理终端侧：按 1/scale 反算字号，
 * 终端屏幕视觉字号与网格列数都不随 UI 缩放变化。
 *
 * **只在落库提交（松手）时调用**：滑块拖动期间不缩放也不修正 —— 一边拖一边整窗重排
 * （终端还得重测字形 + 重排 PTY）会明显跳跃，统一到松手那一次。
 */
export function applyUiScale(percent: number): void {
  applyTerminalUiScale(clampUiScale(percent) / 100)
}
