import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 对照 ATerminal-Swift TerminalHostView 的 WorkspaceFrame / WorkspacePane：
 * 终端卡片 = 黑底 + r10 圆角 + 白 10% 边框 + 投影(黑 0.28 r10 y3)；
 * 外层 pane 垫 sidebar 底色，卡片与容器各留 12/10 的边距。
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
    <div className={cn('relative h-full w-full p-3', className)}>
      <div
        className="relative h-full w-full overflow-hidden rounded-[10px] border border-terminal-border bg-terminal"
        style={{ boxShadow: '0 8px 28px rgba(0, 0, 0, 0.5)' }}
      >
        <div className="absolute inset-[10px]">{children}</div>
        {overlay}
      </div>
    </div>
  )
}
