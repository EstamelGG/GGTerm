// @vitest-environment jsdom
import { expect, it } from 'vitest'
import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
  clampTerminalFontSize,
  clampUiScale
} from '../src/shared/prefs'
import { applyUiScale } from '../src/renderer/src/lib/accent'
import {
  getTerminalFontSize,
  scaledTerminalFontSize,
  setTerminalFontSize,
  setUiScaleFactor
} from '../src/renderer/src/terminal/theme'

/**
 * 尺寸换算不变量：
 * ① UI 缩放（页面缩放，主进程执行）夹紧到 80–150 / 5% 网格；
 * ② 终端字号（Cmd +/-/0）夹紧到 8–24 并取整；
 * ③ 两轴正交：传给 xterm 的 fontSize = 基础字号 / 缩放因子，屏幕字号恒为基础字号；
 * ④ 缩放只在落库提交（松手）那一次落地 —— 拖动期间不缩放、不修正终端。
 */

it('UI 缩放夹紧到 80–150 并吸附到 5% 网格，非法值回默认 100', () => {
  expect(clampUiScale(100)).toBe(100)
  expect(clampUiScale(103)).toBe(105) // 吸附到最近的 5% 档
  expect(clampUiScale(102)).toBe(100)
  expect(clampUiScale(10)).toBe(UI_SCALE_MIN)
  expect(clampUiScale(400)).toBe(UI_SCALE_MAX)
  expect(clampUiScale(Number.NaN)).toBe(100)
  // 非有限值视为非法输入 → 默认档（不放大到上限）
  expect(clampUiScale(Number.POSITIVE_INFINITY)).toBe(100)
})

it('终端字号夹紧到 8–24 并取整，非法值回默认 12', () => {
  expect(clampTerminalFontSize(12)).toBe(12)
  expect(clampTerminalFontSize(12.6)).toBe(13)
  expect(clampTerminalFontSize(1)).toBe(TERMINAL_FONT_SIZE_MIN)
  expect(clampTerminalFontSize(99)).toBe(TERMINAL_FONT_SIZE_MAX)
  expect(clampTerminalFontSize(Number.NaN)).toBe(TERMINAL_FONT_SIZE_DEFAULT)
  // 写入越界值同样被夹紧（菜单/快捷键与将来的设置入口共用同一条路径）
  setTerminalFontSize(0)
  expect(getTerminalFontSize()).toBe(TERMINAL_FONT_SIZE_MIN)
  setTerminalFontSize(TERMINAL_FONT_SIZE_DEFAULT)
  expect(getTerminalFontSize()).toBe(TERMINAL_FONT_SIZE_DEFAULT)
})

it('字号与 UI 缩放正交：屏幕字号 = 基础字号，任何缩放档下都不变', () => {
  setTerminalFontSize(16)
  for (let pct = UI_SCALE_MIN; pct <= UI_SCALE_MAX; pct += UI_SCALE_STEP) {
    setUiScaleFactor(pct / 100)
    // 屏幕尺寸 = CSS 字号 × 页面缩放因子
    expect(scaledTerminalFontSize() * (pct / 100)).toBeCloseTo(16, 10)
  }
  expect(getTerminalFontSize()).toBe(16)
  // 非法因子回退 1（等价于 100%）
  setUiScaleFactor(0)
  expect(scaledTerminalFontSize()).toBe(16)
  // 还原模块级状态，避免影响同文件其它用例
  setTerminalFontSize(TERMINAL_FONT_SIZE_DEFAULT)
  setUiScaleFactor(1)
})

it('UI 缩放只在落库提交时落地：越界值夹紧后按新比例反算终端字号', () => {
  setUiScaleFactor(1)
  const base = getTerminalFontSize()

  applyUiScale(999) // 夹到上限
  expect(scaledTerminalFontSize()).toBeCloseTo(base / (UI_SCALE_MAX / 100), 10)
  applyUiScale(0) // 夹到下限
  expect(scaledTerminalFontSize()).toBeCloseTo(base / (UI_SCALE_MIN / 100), 10)

  applyUiScale(100) // 还原
  expect(scaledTerminalFontSize()).toBe(base)
})
