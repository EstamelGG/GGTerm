/** 捕获指针只保证事件投递；遮罩同时隔离终端、Monaco 和嵌入网页的光标。 */
export function lockResizeCursor(axis: 'x' | 'y', onBlur: () => void): () => void {
  const cursor = axis === 'x' ? 'col-resize' : 'row-resize'
  const style = document.createElement('style')
  style.textContent = `html, html * { cursor: ${cursor} !important; user-select: none !important; }`
  const shield = document.createElement('div')
  shield.setAttribute('aria-hidden', 'true')
  shield.dataset.resizeShield = ''
  shield.style.cssText = `position:fixed;inset:0;z-index:2147483647;cursor:${cursor};-webkit-app-region:no-drag;touch-action:none;`
  document.head.append(style)
  document.body.append(shield)
  window.addEventListener('blur', onBlur)
  return () => {
    style.remove()
    shield.remove()
    window.removeEventListener('blur', onBlur)
  }
}
