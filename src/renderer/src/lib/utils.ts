import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * tailwind-merge 默认只认 T 恤码（xs/sm/base/lg…）为字号；
 * 自定义字号 token（text-caption 等）会被误判为文字颜色，
 * 在 cn('text-caption', 'text-muted') 中被后者删除 → 字号意外回退继承。
 * 这里把项目四档字号显式注册进 font-size 组，与颜色组彻底解耦。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['caption', 'minor', 'body', 'title'] }]
    }
  }
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
