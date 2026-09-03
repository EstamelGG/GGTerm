import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 分段选择器（ChoiceChip 的成组形态，托盘描边 + raised 底）。
 * 选中项样式、托盘规格在此收敛，调用点只传 value/options/onChange；
 * className 可覆写尺寸（如 h-8 与表单输入等高）。
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  className
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (value: T) => void
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex shrink-0 gap-1 rounded-md border border-line bg-raised/60 p-[3px]',
        className
      )}
    >
      {options.map((opt) => (
        <ChoiceChip
          key={opt.value}
          selected={value === opt.value}
          className="rounded-[5px] px-2 py-[3px] text-minor"
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </ChoiceChip>
      ))}
    </div>
  )
}

interface ChoiceChipProps {
  selected?: boolean
  /** block=无框方块（nav/过滤/分段）；pill=描边胶囊（认证方式） */
  shape?: 'block' | 'pill'
  icon?: LucideIcon
  iconSize?: number
  className?: string
  children: ReactNode
  onClick?: () => void
}

/** 单选 chip：表达"当前选中状态"（nav/过滤/分段/认证方式），与动作按钮区分 */
export function ChoiceChip({
  selected = false,
  shape = 'block',
  icon: Icon,
  iconSize = 13,
  className,
  children,
  onClick
}: ChoiceChipProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'no-drag cursor-pointer outline-none transition-colors duration-150 focus-visible:ring-[1.5px] focus-visible:ring-at-accent/70',
        shape === 'pill'
          ? cn(
              'rounded-full border px-3.5 py-1.5 text-body',
              selected
                ? 'border-at-accent/50 bg-raised font-semibold text-fg'
                : 'border-line bg-raised/55 font-medium text-muted hover:bg-hover hover:text-fg'
            )
          : cn(
              'rounded-md',
              selected
                ? 'bg-hover font-medium text-fg ring-1 ring-inset ring-line'
                : 'text-muted hover:bg-hover hover:text-fg'
            ),
        className
      )}
      onClick={onClick}
    >
      <span className="flex items-center gap-1.5">
        {Icon && (
          <Icon
            size={iconSize}
            strokeWidth={2.2}
            className={cn(selected && shape === 'block' && 'text-at-accent')}
          />
        )}
        {children}
      </span>
    </button>
  )
}
