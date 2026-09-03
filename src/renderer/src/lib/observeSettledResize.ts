/** ResizeObserver delivery is noisy during window resizing; commit after 150ms of quiet. */
export function observeSettledResize(element: HTMLElement, commit: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const observer = new ResizeObserver(() => {
    clearTimeout(timer)
    timer = setTimeout(commit, 150)
  })
  observer.observe(element)
  return () => {
    observer.disconnect()
    clearTimeout(timer)
  }
}
