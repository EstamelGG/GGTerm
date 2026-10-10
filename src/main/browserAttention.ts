import { Notification, type BrowserWindow } from 'electron'

const notices = new Map<string, Notification>()
const delivered = new Set<string>()

/** Notify without activating the app. Only a user's notification click may raise it. */
export function notifyBrowserAttention(
  window: BrowserWindow,
  key: string,
  title: string,
  body: string,
  select: () => boolean
): void {
  if (window.isDestroyed() || window.isFocused() || delivered.has(key)) return
  try {
    if (!Notification.isSupported()) return
    const notice = new Notification({ title, body, silent: true })
    delivered.add(key)
    notices.set(key, notice)
    // Bound deduplication state for long-running browser sessions.
    if (delivered.size > 64) {
      const oldest = delivered.values().next().value!
      notices.get(oldest)?.close()
      notices.delete(oldest)
      delivered.delete(oldest)
    }
    notice.on('close', () => notices.delete(key))
    notice.on('failed', () => notices.delete(key))
    notice.on('click', () => {
      if (window.isDestroyed() || !select()) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    })
    notice.show()
  } catch {
    // Notification permission/support must never become a reason to raise a window.
    notices.delete(key)
  }
}

export function clearBrowserAttention(prefix = ''): void {
  for (const key of delivered) {
    if (!key.startsWith(prefix)) continue
    notices.get(key)?.close()
    notices.delete(key)
    delivered.delete(key)
  }
}
