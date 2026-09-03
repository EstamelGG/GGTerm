/** 活动栏面板共用格式化（字节/速率） */

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function fmtSpeed(bytesPerSec: number): string {
  return `${fmtBytes(bytesPerSec)}/s`
}
