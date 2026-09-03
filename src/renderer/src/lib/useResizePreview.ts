import { useRef, useState, type PointerEvent, type KeyboardEvent } from 'react'

interface ResizePreview {
  preview: number | null
  handleProps: {
    role: 'separator'
    tabIndex: number
    'aria-orientation': 'vertical' | 'horizontal'
    'aria-valuenow': number
    'aria-valuemin': number
    'aria-valuemax': number
    onPointerDown: (e: PointerEvent<HTMLElement>) => void
    onPointerMove: (e: PointerEvent<HTMLElement>) => void
    onPointerUp: () => void
    onPointerCancel: () => void
    onLostPointerCapture: () => void
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
  }
}

/** 拖动时只移动预览线，松手后提交尺寸，避免持续重排终端/Monaco。 */
export function useResizePreview({
  value,
  min,
  max,
  axis = 'x',
  direction = 1,
  onCommit,
  onPreview
}: {
  value: number
  min: number
  max: number
  axis?: 'x' | 'y'
  direction?: 1 | -1
  onCommit: (value: number) => void
  onPreview: (value: number) => void
}): ResizePreview {
  const [preview, setPreview] = useState<number | null>(null)
  const origin = useRef<{ value: number; position: number } | null>(null)
  const pending = useRef<number | null>(null)
  const clamp = (v: number): number => Math.min(max, Math.max(min, v))
  const end = (): void => {
    if (pending.current !== null) onCommit(clamp(pending.current))
    pending.current = null
    origin.current = null
    setPreview(null)
  }
  return {
    preview,
    handleProps: {
      role: 'separator' as const,
      tabIndex: 0,
      'aria-orientation': axis === 'x' ? ('vertical' as const) : ('horizontal' as const),
      'aria-valuenow': value,
      'aria-valuemin': min,
      'aria-valuemax': max,
      onPointerDown: (e: PointerEvent<HTMLElement>): void => {
        if (e.button !== 0) return
        e.preventDefault()
        origin.current = { value, position: axis === 'x' ? e.clientX : e.clientY }
        pending.current = value
        setPreview(value)
        e.currentTarget.setPointerCapture(e.pointerId)
      },
      onPointerMove: (e: PointerEvent<HTMLElement>): void => {
        const base = origin.current
        if (!base) return
        const position = axis === 'x' ? e.clientX : e.clientY
        pending.current = clamp(base.value + direction * (position - base.position))
        onPreview(pending.current)
      },
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
      onKeyDown: (e: KeyboardEvent<HTMLElement>): void => {
        const decrease = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
        const increase = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
        if (e.key !== decrease && e.key !== increase) return
        e.preventDefault()
        onCommit(clamp(value + (e.key === increase ? 16 : -16) * direction))
      }
    }
  }
}
