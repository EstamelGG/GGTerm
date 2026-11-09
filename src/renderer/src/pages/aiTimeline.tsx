import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 步骤时间线（AI 工作区消息流）：节点圆点常量与节点组件。
 * 三类内容的视觉首行高度不同，圆点偏移（dotTop）按类型取值：
 * - 正文：body(13px) 文字首行中心 ≈ 9px
 * - 思考：caption(11px) 标题行中心 ≈ 6px
 * - 工具卡：边框 1px + 行内边距 6px + 12px 图标行中心 ≈ 11px
 */
export const THINKING_DOT = 'bg-muted/50'
export const TEXT_DOT = 'bg-fg/40'

export const DOT_TOP_TEXT = 9
export const DOT_TOP_THINKING = 6
export const DOT_TOP_TOOL = 11

/**
 * 时间线节点：左侧竖线 + 状态点，右侧节点内容（非末节点用 pb 撑开间距）。
 * 首/末节点不画对应侧的连接线；圆点盖住竖线形成节点。
 */
export function TimelineNode({
  dotCls,
  dotTop,
  first,
  last,
  children
}: {
  dotCls: string
  /** 圆点 top 偏移（px） */
  dotTop: number
  first: boolean
  last: boolean
  children: ReactNode
}): React.JSX.Element {
  const center = dotTop + 8 // 圆点中心（8px 圆直径）
  return (
    <div className="relative flex gap-2.5">
      <div className="relative w-3 shrink-0" aria-hidden>
        {!first && (
          <span className="absolute left-[5.5px] top-0 w-px bg-line" style={{ height: dotTop }} />
        )}
        {!last && (
          <span className="absolute bottom-0 left-[5.5px] w-px bg-line" style={{ top: center }} />
        )}
        <span
          className={cn('absolute left-[2px] h-2 w-2 rounded-full', dotCls)}
          style={{ top: dotTop }}
        />
      </div>
      <div className={cn('min-w-0 flex-1', !last && 'pb-3')}>{children}</div>
    </div>
  )
}
