import { useLayoutEffect, useState, type RefObject } from 'react'
import { browserOverlayManager } from './browserOverlayManager'

/** Coordinate all native visibility, bounds and screenshot swaps in one place. */
export function useBrowserSurface(
  viewport: RefObject<HTMLElement | null>,
  tabId: string | null,
  enabled: boolean
): { occluded: boolean; preview: string | null } {
  const [occluded, setOccluded] = useState(false)
  const [capture, setCapture] = useState<{ id: string; image: string } | null>(null)
  useLayoutEffect(() => {
    const page = viewport.current
    if (!enabled || !tabId || !page) {
      void window.aterm.browser.layout(null, null).catch(() => {})
      return
    }
    let live = true
    let blocked = false
    let capturing = false
    const takeScreenshot = (): void => {
      if (capturing || !live) return
      capturing = true
      void window.aterm.browser
        .preview(tabId)
        .then((image) => {
          if (live && image) setCapture({ id: tabId, image })
        })
        .catch(() => {})
        .finally(() => {
          capturing = false
        })
    }
    const layout = (): void => {
      const next = browserOverlayManager().overlaps(page)
      if (next && !blocked) takeScreenshot()
      blocked = next
      setOccluded(next)
      const rect = page.getBoundingClientRect()
      const visible = !blocked && rect.width > 0 && rect.height > 0
      void window.aterm.browser
        .layout(
          visible ? tabId : null,
          visible
            ? {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
              }
            : null
        )
        .catch(() => {})
    }
    const off = browserOverlayManager().subscribe(layout)
    const observer = new ResizeObserver(layout)
    observer.observe(page)
    // Keep a recent placeholder underneath the live page, so opening menus doesn't flash blank.
    if (!blocked) takeScreenshot()
    const timer = window.setInterval(() => {
      if (!blocked) takeScreenshot()
    }, 1000)
    window.addEventListener('resize', layout)
    return () => {
      live = false
      off()
      observer.disconnect()
      window.clearInterval(timer)
      window.removeEventListener('resize', layout)
      void window.aterm.browser.layout(null, null).catch(() => {})
    }
  }, [enabled, tabId, viewport])
  return { occluded: enabled && occluded, preview: capture?.id === tabId ? capture.image : null }
}
