import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'

/**
 * 走马灯文本（chrome 共用）：仅溢出时左右来回滚动。
 * 位移量经 --marquee-shift 注入；ease-in-out + alternate，首尾各留停顿（18%/82%）；
 * hover 暂停；系统减动效时 CSS 降级为截断（见 main.css 的 at-marquee）。
 */

/** 溢出检测 + 滚动位移量（box/text 双 ref 由调用方自行布局） */
export function useMarqueeShift(text: string): {
  boxRef: React.RefObject<HTMLSpanElement | null>
  textRef: React.RefObject<HTMLSpanElement | null>
  overflow: boolean
  shift: number
} {
  const boxRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const [shift, setShift] = useState(0)
  const [overflow, setOverflow] = useState(false)
  useEffect(() => {
    const box = boxRef.current
    const span = textRef.current
    if (!box || !span) return
    const measure = (): void => {
      const d = span.scrollWidth - box.clientWidth
      setOverflow(d > 2)
      setShift(Math.max(0, d))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    ro.observe(span)
    return () => ro.disconnect()
  }, [text])
  return { boxRef, textRef, overflow, shift }
}

/** 独立走马灯文本块（block、占满可用宽度） */
export function MarqueeText({
  text,
  className,
  style
}: {
  text: string
  /** 滚动文本样式（字号/颜色等，挂在文本 span 上） */
  className?: string
  style?: CSSProperties
}): React.JSX.Element {
  const { boxRef, textRef, overflow, shift } = useMarqueeShift(text)
  return (
    <span ref={boxRef} className="at-marquee-box block w-full overflow-hidden whitespace-nowrap">
      <span
        ref={textRef}
        className={cn('inline-block', overflow && 'at-marquee', className)}
        style={overflow ? ({ ...style, '--marquee-shift': `${-shift}px` } as CSSProperties) : style}
      >
        {text}
      </span>
    </span>
  )
}
