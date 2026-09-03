import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 结构性行展开/收起动画（grid-rows 0fr↔1fr 技巧，无需测量具体高度）：
 * 用于"首个内容出现/全关消失"的整行（主机条、文件标签行）——行高 200ms 过渡，
 * 行内 flex 子区（编辑器等 flex-1）随剩余空间逐帧联动，无跳变。
 * 内容必须始终挂载（open=false 时 0fr + overflow-hidden 完全隐藏）；
 * 内层 flex flex-col 保持原 flex 链（子元素 flex-1 行为与直接挂载时一致）。
 */
export function RevealRow({
  open,
  className,
  children
}: {
  open: boolean
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        className
      )}
    >
      <div className="flex flex-col overflow-hidden">{children}</div>
    </div>
  )
}
