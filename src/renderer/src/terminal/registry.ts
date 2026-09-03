import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { PatternHighlightAddon } from '@/terminal/patternHighlight'
import {
  buildTerminalTheme,
  readAccentHex,
  scaledTerminalFontSize,
  setTerminalFontSize,
  setUiScaleFactor,
  terminalFontFamily,
  terminalLineHeight,
  terminalScrollback
} from '@/terminal/theme'

/**
 * 终端实例注册表：xterm 实例与 React 组件生命周期解耦。
 * - 实例由 store 层动作创建/销毁（PTY 会话存在期间一直活着）
 * - 组件挂载时把实例 DOM 搬进容器、卸载时搬走 —— buffer/滚动全保留
 * - 页面不可见期间 PTY 输出照常 write 进实例，回来后零丢失
 */

interface TermEntry {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  /** xterm 根 DOM（term.open 后存在；组件卸载时随实例保留） */
  el: HTMLElement
  opened: boolean
}

const registry = new Map<string, TermEntry>()

export interface CreateTerminalOptions {
  /** Output-only viewers neither accept keyboard input nor forward terminal responses. */
  readOnly?: boolean
  /** 键盘输入路由（写 PTY） */
  onData: (data: string) => void
  /** 尺寸变化路由（同步 PTY） */
  onResize?: (cols: number, rows: number) => void
}

export function createTerminal(key: string, opts: CreateTerminalOptions): Terminal {
  disposeTerminal(key)
  const term = new Terminal({
    fontFamily: terminalFontFamily,
    fontSize: scaledTerminalFontSize(),
    lineHeight: terminalLineHeight,
    scrollback: terminalScrollback,
    allowProposedApi: true,
    cursorBlink: !opts.readOnly,
    disableStdin: opts.readOnly ?? false,
    theme: buildTerminalTheme(readAccentHex())
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon())
  term.loadAddon(new PatternHighlightAddon())
  if (!opts.readOnly) term.onData((d) => opts.onData(d))
  term.onResize(({ cols, rows }) => opts.onResize?.(cols, rows))

  registry.set(key, { term, fit, search, el: document.createElement('div'), opened: false })
  return term
}

/** 把实例 DOM 挂进容器（组件挂载时调用；首次会执行 term.open） */
export function attachTerminal(key: string, container: HTMLElement): void {
  const entry = registry.get(key)
  if (!entry || !container.isConnected) return
  if (!entry.opened) {
    entry.term.open(container)
    entry.opened = true
    entry.el = entry.term.element ?? entry.el
    // WebGL 渲染在容器可见、尺寸有效时启用；失败回退 DOM 渲染
    if (container.clientWidth > 0 && container.clientHeight > 0) {
      try {
        entry.term.loadAddon(new WebglAddon())
      } catch {
        /* ignore */
      }
    }
  } else {
    container.appendChild(entry.el)
  }
}

/** 从容器摘下实例 DOM（组件卸载时调用；实例保留） */
export function detachTerminal(key: string, container: HTMLElement): void {
  const entry = registry.get(key)
  if (!entry) return
  if (entry.opened && entry.el.parentElement === container) {
    container.removeChild(entry.el)
  }
}

/** 容器尺寸有效时自适应 */
export function refreshTerminalFonts(key: string): void {
  const entry = registry.get(key)
  if (!entry?.opened) return
  entry.term.clearTextureAtlas()
  entry.fit.fit()
  entry.term.refresh(0, entry.term.rows - 1)
}

/** 把当前字号（基础字号 ÷ UI 缩放）刷到全部终端实例并重排一次 PTY */
function applyFontToAll(): void {
  for (const [key, entry] of registry) {
    entry.term.options.fontSize = scaledTerminalFontSize()
    refreshTerminalFonts(key)
  }
}

/**
 * UI 缩放变化（factor = 页面缩放因子，1 = 100%）：全部终端按 1/factor 反算字号 ——
 * 终端屏幕视觉字号与网格列数都不随 UI 缩放变化（详见 theme.scaledTerminalFontSize）。
 * 只在落库提交时调用；滑块拖动期间不缩放也不修正终端（见 lib/accent.applyUiScale）。
 */
export function applyTerminalUiScale(factor: number): void {
  setUiScaleFactor(factor)
  applyFontToAll()
}

/** 终端字号变化（Cmd +/-/0）：改基础字号后即时重排全部终端（屏幕字号 = 该值，与 UI 缩放正交） */
export function applyTerminalFontSize(px: number): void {
  setTerminalFontSize(px)
  applyFontToAll()
}

export function fitTerminal(key: string, container: HTMLElement): void {
  const entry = registry.get(key)
  if (!entry || container.clientWidth <= 0 || container.clientHeight <= 0) return
  try {
    entry.fit.fit()
  } catch {
    /* 布局未就绪时忽略 */
  }
}

export function writeTerminal(key: string, data: string): void {
  registry.get(key)?.term.write(data)
}

/** 拖放/粘贴文本进终端（xterm paste：处理括号粘贴模式，经 onData 写 PTY） */
export function pasteTerminal(key: string, text: string): void {
  registry.get(key)?.term.paste(text)
}

export function focusTerminal(key: string): void {
  registry.get(key)?.term.focus()
}

export function terminalSelection(key: string): string {
  return registry.get(key)?.term.getSelection() ?? ''
}
export function findTerminal(key: string, text: string, backwards = false): boolean {
  const entry = registry.get(key)
  if (!entry || !text) return false
  return backwards ? entry.search.findPrevious(text) : entry.search.findNext(text)
}

export function disposeTerminal(key: string): void {
  const entry = registry.get(key)
  if (!entry) return
  registry.delete(key)
  try {
    entry.term.dispose()
  } catch {
    /* ignore */
  }
}
