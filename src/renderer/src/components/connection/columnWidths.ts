/** 连接列定宽；主机列唯一可拖宽，延迟/性能区（flex）吸收剩余空间。 */
export const LIVE_WIDTH = 150
export const HOST_MIN_WIDTH = 190

const STORAGE_KEY = 'ggterm.row-v2.host'
/** 旧版连接列偏好已废弃，清理用户 localStorage 残留 */
const LEGACY_LIVE_KEY = 'aterminal.row-v2.live'
const HOST_DEFAULT_WIDTH = 310

export function loadPreferred(): number {
  localStorage.removeItem(LEGACY_LIVE_KEY)
  const value = Number(localStorage.getItem(STORAGE_KEY))
  return Number.isFinite(value) && value >= HOST_MIN_WIDTH ? value : HOST_DEFAULT_WIDTH
}

export function persistPreferred(width: number): void {
  localStorage.setItem(STORAGE_KEY, String(width))
}

/** 拖拽中 pinned 1:1 跟随指针，否则用 preferred；上限留给定宽连接列。 */
export function resolveHostWidth(preferred: number, available: number, pinned?: number): number {
  return Math.max(
    HOST_MIN_WIDTH,
    Math.min(pinned ?? preferred, Math.max(320, available) - LIVE_WIDTH)
  )
}
