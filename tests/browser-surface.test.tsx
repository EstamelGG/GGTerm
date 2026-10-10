// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { useBrowserSurface } from '../src/renderer/src/lib/useBrowserSurface'

const layout = vi.fn(async () => {})
const preview = vi.fn(async () => 'data:image/png;base64,cached')
function Surface({ id = 'page' }: { id?: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const state = useBrowserSurface(ref, id, true)
  return (
    <div ref={ref} data-testid="page" data-blocked={state.occluded}>
      {state.preview}
    </div>
  )
}
const bounds = (x: number, y: number, width: number, height: number): DOMRect =>
  ({
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    toJSON() {}
  }) as DOMRect
beforeEach(() => {
  layout.mockClear()
  preview.mockReset().mockResolvedValue('data:image/png;base64,cached')
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testid === 'page' ? bounds(200, 100, 600, 400) : bounds(250, 150, 100, 100)
  })
  Object.assign(window, { aterm: { browser: { layout, preview } } })
})
afterEach(() => {
  cleanup()
  document.body.style.pointerEvents = ''
  document.querySelectorAll('[role="menu"], [role="dialog"]').forEach((node) => node.remove())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('parks the native page under a menu, keeps its screenshot, and restores it on dismissal', async () => {
  render(<Surface />)
  await screen.findByText('data:image/png;base64,cached')
  expect(layout).toHaveBeenLastCalledWith('page', { x: 200, y: 100, width: 600, height: 400 })
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  await act(async () => {
    document.body.append(menu)
  })
  await waitFor(() => expect(layout).toHaveBeenLastCalledWith(null, null))
  expect(screen.getByTestId('page').dataset.blocked).toBe('true')
  expect(screen.getByText('data:image/png;base64,cached')).toBeTruthy()
  await act(async () => {
    menu.remove()
  })
  await waitFor(() => expect(layout).toHaveBeenLastCalledWith('page', expect.any(Object)))
  expect(screen.getByTestId('page').dataset.blocked).toBe('false')
})
it('ignores non-overlapping menus but honors modal outside-click locks', async () => {
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  menu.getBoundingClientRect = () => bounds(0, 0, 50, 50)
  document.body.append(menu)
  render(<Surface />)
  await screen.findByText('data:image/png;base64,cached')
  expect(screen.getByTestId('page').dataset.blocked).toBe('false')
  await act(async () => {
    document.body.style.pointerEvents = 'none'
  })
  await waitFor(() => expect(screen.getByTestId('page').dataset.blocked).toBe('true'))
  await act(async () => {
    document.body.style.pointerEvents = ''
  })
  await waitFor(() => expect(screen.getByTestId('page').dataset.blocked).toBe('false'))
})
it('does not replace a new tab snapshot with a late capture from the previous tab', async () => {
  let resolveOld!: (value: string) => void
  preview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve
      })
  )
  const view = render(<Surface id="old" />)
  view.rerender(<Surface id="new" />)
  await screen.findByText('data:image/png;base64,cached')
  await act(async () => {
    resolveOld('old-image')
  })
  expect(screen.queryByText('old-image')).toBeNull()
  expect(layout).toHaveBeenLastCalledWith('new', expect.any(Object))
})
