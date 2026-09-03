import type { BrowserWindow } from 'electron'
import { TERMINAL_FONT_SIZE_STEP, nextTerminalFontSize } from '../shared/prefs'
import { getPreferences, setPreferences } from './data/prefs'

/**
 * 终端字号步进（View 菜单三项与窗口快捷键共用）：只改偏好 —— 写盘后经 prefs:changed 广播，
 * 渲染层据此把字号套用到全部终端实例（终端实例在渲染层）。
 * delta = 0 表示复位到默认值；夹紧后与当前值相同则不写盘。
 */
export function stepTerminalFont(delta: number): void {
  const cur = getPreferences().terminalFontSize
  const next = nextTerminalFontSize(cur, delta)
  if (next !== cur) setPreferences({ terminalFontSize: next })
}

/** 物理键位（与键盘布局 / 输入法无关）→ 步进量；null = 不处理 */
function deltaForCode(code: string): number | null {
  switch (code) {
    case 'Equal': // Cmd+= 与 Cmd+Shift+=（"+"）同码位
    case 'NumpadAdd':
      return TERMINAL_FONT_SIZE_STEP
    case 'Minus':
    case 'NumpadSubtract':
      return -TERMINAL_FONT_SIZE_STEP
    case 'Digit0':
    case 'Numpad0':
      return 0
    default:
      return null
  }
}

/**
 * 窗口级快捷键：Cmd（macOS）/ Ctrl + "=" | "+" 放大、"-" 缩小、"0" 复位。
 *
 * 用 before-input-event 在**页面之前**拦下按键（命中即 preventDefault）：不受 xterm 消费、
 * 输入法 / 键盘布局（按物理 code 匹配）、以及渲染层任何事件处理影响。
 * View 菜单已绑定的组合会先被菜单吃下、走菜单 click —— 两条路都落到 stepTerminalFont。
 */
export function installTerminalFontKeys(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt) return
    const isMac = process.platform === 'darwin'
    const mod = isMac ? input.meta && !input.control : input.control
    if (!mod) return
    const delta = deltaForCode(input.code)
    if (delta === null) return
    event.preventDefault()
    stepTerminalFont(delta)
  })
}
