/** 主题工具（对照 ATerminal-Swift Theme.swift 的 hex 解析/归一化） */

export const defaultAccentHex = '#37A563'

export const groupColors = [
  '#FF7700',
  '#37A563',
  '#3B82F6',
  '#E11D48',
  '#A855F7',
  '#EAB308',
  '#06B6D4',
  '#94A3B8'
]

/** 校验并归一化 #RRGGBB；非法返回 null（对照 Theme.normalizeHex） */
export function normalizeHex(raw: string): string | null {
  const h = raw.trim().replace(/^#/, '')
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return null
  return `#${h.toUpperCase()}`
}

/** 任意输入转 css 颜色；非法回退默认强调色（对照 Theme.color） */
export function hexToCss(raw: string): string {
  return normalizeHex(raw) ?? defaultAccentHex
}
