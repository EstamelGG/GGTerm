import { beforeEach, expect, it, vi } from 'vitest'
import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  nextTerminalFontSize
} from '../src/shared/prefs'

/**
 * 终端字号步进：View 菜单三项与窗口快捷键（before-input-event）共用 main/terminalFont.stepTerminalFont ——
 * 只写偏好，渲染层经 prefs:changed 把字号套用到全部终端实例。
 */

const prefs = vi.hoisted(() => ({ getPreferences: vi.fn(), setPreferences: vi.fn() }))
vi.mock('../src/main/data/prefs', () => prefs)

const { stepTerminalFont } = await import('../src/main/terminalFont')

/** 当前偏好值（写盘后 getPreferences 即返回新值） */
const at = (size: number): void => {
  prefs.getPreferences.mockReturnValue({ terminalFontSize: size })
}
const written = (): number | undefined =>
  (prefs.setPreferences.mock.calls.at(-1)?.[0] as { terminalFontSize?: number } | undefined)
    ?.terminalFontSize

beforeEach(() => {
  vi.clearAllMocks()
})

it('放大 / 缩小 / 复位都落到偏好（写盘后由渲染层套用）', () => {
  at(12)
  stepTerminalFont(1)
  expect(written()).toBe(13)

  at(13)
  stepTerminalFont(-1)
  expect(written()).toBe(12)

  at(20)
  stepTerminalFont(0) // 复位
  expect(written()).toBe(TERMINAL_FONT_SIZE_DEFAULT)
})

it('到达上下限后不再写盘', () => {
  at(TERMINAL_FONT_SIZE_MIN)
  stepTerminalFont(-1)
  expect(prefs.setPreferences).not.toHaveBeenCalled()

  at(TERMINAL_FONT_SIZE_MAX)
  stepTerminalFont(1)
  expect(prefs.setPreferences).not.toHaveBeenCalled()
})

it('nextTerminalFontSize：步进、复位与夹紧', () => {
  expect(nextTerminalFontSize(12, 1)).toBe(13)
  expect(nextTerminalFontSize(12, -1)).toBe(11)
  expect(nextTerminalFontSize(12, 0)).toBe(TERMINAL_FONT_SIZE_DEFAULT)
  expect(nextTerminalFontSize(TERMINAL_FONT_SIZE_MIN, -1)).toBe(TERMINAL_FONT_SIZE_MIN)
  expect(nextTerminalFontSize(TERMINAL_FONT_SIZE_MAX, 1)).toBe(TERMINAL_FONT_SIZE_MAX)
  expect(nextTerminalFontSize(Number.NaN, 1)).toBe(TERMINAL_FONT_SIZE_DEFAULT + 1)
})
