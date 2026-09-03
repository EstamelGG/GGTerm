import type { ITheme } from '@xterm/xterm'
import { TERMINAL_FONT_SIZE_DEFAULT, clampTerminalFontSize } from '@shared/prefs'

/** 对照 ATerminal-Swift ThemeNS + TerminalChrome：黑底、0.86/0.88/0.90 前景、accent 光标 */
export function buildTerminalTheme(accentHex: string): ITheme {
  return {
    background: '#000000',
    foreground: '#dbdfe6',
    cursor: accentHex,
    cursorAccent: '#000000',
    selectionBackground: 'rgba(255, 255, 255, 0.25)',
    selectionInactiveBackground: 'rgba(255, 255, 255, 0.12)'
  }
}

export function readAccentHex(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--at-accent').trim()
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#37A563'
}

/** 与 CSS / Monaco 共用唯一字体栈，两个字体均随应用打包。 */
export const terminalFontFamily = getComputedStyle(document.documentElement)
  .getPropertyValue('--font-mono')
  .trim()

/** 终端字号的默认值 / 范围 / 步进 / 夹紧统一在 @shared/prefs（主进程的菜单与快捷键也要用同一份） */

/** 当前基础字号（用户可调：Cmd +/-/0 或 View 菜单）：屏幕视觉字号 = 该值（UI 缩放经 1/factor 反算抵消） */
let baseFontSize: number = TERMINAL_FONT_SIZE_DEFAULT

/** 设置基础字号（越界自动夹紧） */
export function setTerminalFontSize(px: number): void {
  baseFontSize = clampTerminalFontSize(px)
}

/** 当前基础字号（px） */
export function getTerminalFontSize(): number {
  return baseFontSize
}

/**
 * 当前 UI 缩放因子（1 = 100%）：页面缩放会把 CSS px 放大 factor 倍，
 * 故传给 xterm 的字号按 1/factor 反算 —— 终端屏幕视觉字号恒为基础字号，不随 UI 缩放变化。
 */
let uiScaleFactor = 1

/** 设置 UI 缩放因子（非法值 / ≤0 视为 1） */
export function setUiScaleFactor(factor: number): void {
  uiScaleFactor = Number.isFinite(factor) && factor > 0 ? factor : 1
}

/** 传给 xterm 的 fontSize（CSS px）：屏幕尺寸 = 该值 × 缩放因子，反算后与缩放无关 */
export function scaledTerminalFontSize(): number {
  return baseFontSize / uiScaleFactor
}
/**
 * 行距倍率：1 = 字体自然行高（xterm 自动取 fontBoundingBox，随内置字体自适应），
 * 超出 1 的部分即额外行间距。1.1 = 自流行高 + 10% 间距；不裁切下限 ≈1.07（由字体盒比例决定）。
 */
export const terminalLineHeight = 1.1

let fontsReady: Promise<void> | undefined
export function loadTerminalFonts(): Promise<void> {
  // Canvas 不会像 DOM 一样按文字触发 unicode-range 分片下载；预加载全部中文分片。
  return (fontsReady ??= Promise.all(
    Array.from(document.fonts)
      .filter((face) => /JetBrains Mono|Noto Sans SC Variable/.test(face.family))
      .map((face) => face.load())
  )
    .then(() => undefined)
    .catch((error) => {
      fontsReady = undefined
      throw error
    }))
}
export const terminalScrollback = 10_000
