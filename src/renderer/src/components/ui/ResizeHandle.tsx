import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/** 热区与视觉线分离，外层只占 1px；边缘模式供 overflow-hidden 面板使用。 */
export function ResizeHandle({
  axis = 'x',
  edge,
  active = false,
  className,
  ...props
}: ComponentProps<'div'> & {
  axis?: 'x' | 'y'
  edge?: 'start'
  active?: boolean
}): React.JSX.Element {
  return (
    <div
      {...props}
      className={cn('at-resize-handle', className)}
      data-axis={axis}
      data-edge={edge}
      data-active={active || undefined}
    />
  )
}
