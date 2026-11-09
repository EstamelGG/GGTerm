// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { KeyboardEvent, PointerEvent } from 'react'
import { useResizePreview } from '../src/renderer/src/lib/useResizePreview'

afterEach(cleanup)
const pointer = (x: number): PointerEvent<HTMLElement> =>
  ({
    button: 0,
    clientX: x,
    clientY: x,
    pointerId: 1,
    preventDefault: vi.fn(),
    currentTarget: { setPointerCapture: vi.fn() }
  }) as unknown as PointerEvent<HTMLElement>

it('previews bounded movement and commits once on release followed by lost capture', () => {
  const onCommit = vi.fn()
  const onPreview = vi.fn()
  const { result } = renderHook(() =>
    useResizePreview({
      value: 300,
      min: 240,
      max: 480,
      direction: -1,
      onCommit,
      onPreview
    })
  )
  act(() => result.current.handleProps.onPointerDown(pointer(100)))
  act(() => result.current.handleProps.onPointerMove(pointer(-200)))
  expect(onPreview).toHaveBeenLastCalledWith(480)
  expect(onCommit).not.toHaveBeenCalled()
  act(() => result.current.handleProps.onPointerUp())
  act(() => result.current.handleProps.onLostPointerCapture())
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(480)
  expect(result.current.preview).toBeNull()
})

it('supports keyboard resizing on the vertical axis and respects the lower bound', () => {
  const onCommit = vi.fn()
  const { result } = renderHook(() =>
    useResizePreview({
      value: 245,
      min: 240,
      max: 480,
      axis: 'y',
      onCommit,
      onPreview: vi.fn()
    })
  )
  const preventDefault = vi.fn()
  act(() =>
    result.current.handleProps.onKeyDown({
      key: 'ArrowUp',
      preventDefault
    } as unknown as KeyboardEvent<HTMLElement>)
  )
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(240)
  expect(preventDefault).toHaveBeenCalledOnce()
})

it('locks the cursor across embedded content and releases it when capture is cancelled', () => {
  const { result } = renderHook(() =>
    useResizePreview({ value: 300, min: 240, max: 480, onCommit: vi.fn(), onPreview: vi.fn() })
  )
  act(() => result.current.handleProps.onPointerDown(pointer(100)))
  expect(document.querySelector('[data-resize-shield]')).not.toBeNull()
  expect(document.head.textContent).toContain('cursor: col-resize !important')
  act(() => result.current.handleProps.onPointerCancel())
  expect(document.querySelector('[data-resize-shield]')).toBeNull()
  expect(document.head.textContent).not.toContain('cursor: col-resize !important')
})

it('commits the latest movement on window blur and cleans up on unmount', () => {
  const onCommit = vi.fn()
  const { result, unmount } = renderHook(() =>
    useResizePreview({ value: 300, min: 240, max: 480, axis: 'y', onCommit, onPreview: vi.fn() })
  )
  act(() => result.current.handleProps.onPointerDown(pointer(100)))
  act(() => result.current.handleProps.onPointerMove(pointer(150)))
  act(() => window.dispatchEvent(new Event('blur')))
  act(() => result.current.handleProps.onLostPointerCapture())
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(350)
  expect(result.current.preview).toBeNull()
  expect(document.querySelector('[data-resize-shield]')).toBeNull()
  act(() => result.current.handleProps.onPointerDown(pointer(100)))
  unmount()
  expect(document.querySelector('[data-resize-shield]')).toBeNull()
  expect(document.head.textContent).not.toContain('cursor: row-resize !important')
})
