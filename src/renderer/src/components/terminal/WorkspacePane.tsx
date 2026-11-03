import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 终端工作区：用 AT 间距与圆角保留边界，避免多层留白挤压终端视口。
 */
export function WorkspacePane({
  children,
  overlay,
  className
}: {
  children: ReactNode
  overlay?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('relative h-full w-full p-[var(--at-workspace-inset)]', className)}>
      <div className="relative h-full w-full overflow-hidden rounded-[var(--at-panel-radius)] border border-terminal-border bg-terminal">
        <div className="absolute inset-[var(--at-terminal-inset)]">{children}</div>
        {overlay}
      </div>
    </div>
  )
}
