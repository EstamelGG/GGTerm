import { cn } from '@/lib/utils'
import type { StateDotVisual } from '@/lib/linkPhase'

/**
 * 6px 状态点（连接列表名称前 / 顶部标签页共用）：
 * 空心 = 没在连接；实心绿 = 已连接；黄点呼吸 = 尝试中；红 = 失败（视觉映射见 linkPhase.linkStateDot）。
 */
export function StateDot({
  visual,
  title
}: {
  visual: StateDotVisual
  title?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full border transition-colors duration-300',
        visual.pulsing && 'animate-[state-dot-blink_0.9s_ease-in-out_infinite]'
      )}
      style={{
        borderColor: visual.color,
        backgroundColor: visual.filled ? visual.color : 'transparent'
      }}
      title={title}
    />
  )
}
