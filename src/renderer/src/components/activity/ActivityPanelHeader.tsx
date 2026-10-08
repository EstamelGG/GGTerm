import type { ReactNode } from 'react'
import { ChromeSeparator } from '@/components/chrome/ChromeSeparator'
import { TOOLBAR_V } from '@/components/chrome/layout'
import { cn } from '@/lib/utils'

/** 右侧面板共用 40px 内容行 + 1px 分割线，与主机工具栏对齐。 */
export function ActivityPanelHeader({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <>
      <div className={cn('flex h-10 shrink-0 items-center gap-2 px-3', TOOLBAR_V)}>{children}</div>
      <ChromeSeparator />
    </>
  )
}
