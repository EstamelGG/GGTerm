const overlaySelector = [
  '[role="menu"]',
  '[role="listbox"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="tooltip"]',
  '[data-slot="popover-content"]',
  '[data-slot="hover-card-content"]'
].join(',')

/** One observer per window; only floating UI gets attribute/geometry observers. */
class BrowserOverlayManager {
  private listeners = new Set<() => void>()
  private elements = new Set<HTMLElement>()
  private pending = false
  private structure = new MutationObserver(() => {
    this.track()
    this.notify()
  })
  private attributes = new MutationObserver(() => this.notify())
  private sizes = new ResizeObserver(() => this.notify())
  private notify = (): void => {
    if (this.pending) return
    this.pending = true
    queueMicrotask(() => {
      this.pending = false
      for (const listener of this.listeners) listener()
    })
  }
  private track(): void {
    const next = new Set(document.querySelectorAll<HTMLElement>(overlaySelector))
    if (
      next.size === this.elements.size &&
      [...next].every((element) => this.elements.has(element))
    )
      return
    this.elements = next
    this.attributes.disconnect()
    this.sizes.disconnect()
    this.attributes.observe(document.body, { attributes: true, attributeFilter: ['style'] })
    for (const element of next) {
      this.attributes.observe(element, {
        attributes: true,
        subtree: true,
        childList: true,
        attributeFilter: ['style', 'class', 'data-state', 'aria-hidden', 'aria-modal', 'hidden']
      })
      this.sizes.observe(element)
    }
  }
  subscribe(listener: () => void): () => void {
    if (!this.listeners.size) {
      this.structure.observe(document.body, { childList: true, subtree: true })
      this.attributes.observe(document.body, { attributes: true, attributeFilter: ['style'] })
      this.track()
      window.addEventListener('resize', this.notify)
    }
    this.listeners.add(listener)
    listener()
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) {
        this.structure.disconnect()
        this.attributes.disconnect()
        this.sizes.disconnect()
        this.elements.clear()
        window.removeEventListener('resize', this.notify)
      }
    }
  }
  overlaps(page: HTMLElement): boolean {
    // Radix modal menus also block outside clicks. Native pages must honor that lock.
    if (document.body.style.pointerEvents === 'none') return true
    const bounds = page.getBoundingClientRect()
    for (const element of this.elements) {
      if (element.contains(page) || page.contains(element)) continue
      if (element.dataset.state === 'closed' || element.closest('[aria-hidden="true"], [hidden]'))
        continue
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none')
        continue
      if (element.getAttribute('aria-modal') === 'true') return true
      const left = Math.max(rect.left, bounds.left),
        right = Math.min(rect.right, bounds.right)
      const top = Math.max(rect.top, bounds.top),
        bottom = Math.min(rect.bottom, bounds.bottom)
      if (left >= right || top >= bottom) continue
      // Ignore floating UI painted behind this browser's DOM placeholder.
      const hit = document.elementFromPoint?.((left + right) / 2, (top + bottom) / 2)
      if (!hit || element.contains(hit)) return true
    }
    return false
  }
}
let manager: BrowserOverlayManager | undefined
export function browserOverlayManager(): BrowserOverlayManager {
  return (manager ??= new BrowserOverlayManager())
}
