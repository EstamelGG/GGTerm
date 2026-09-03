import { useEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ButtonTooltip } from './ButtonTooltip'

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  /** 图标尺寸 px */
  size?: number
  /** 按钮框尺寸 px（22 表单内 / 26 行内） */
  frame?: number
  cornerRadius?: number
  /** accent=改变外部状态的动作（常驻显示）；muted=纯视图类（行级 hover 浮现） */
  tone?: 'accent' | 'muted'
  /** 受控选中/打开态（如 Popover 打开中的眼睛） */
  selected?: boolean
  strokeWidth?: number
  variant?: 'ghost' | 'toolbar'
  filled?: boolean
}

/** I2 ghost 微钮：无框、hover 背景高亮、active:scale 按压；行内/表单/弹窗通用 */
export function IconButton({
  icon: Icon,
  size = 12,
  frame = 26,
  cornerRadius = 6,
  tone = 'muted',
  variant = 'ghost',
  filled = false,
  selected = false,
  strokeWidth = 2.2,
  className,
  title,
  ...rest
}: IconButtonProps): React.JSX.Element {
  // title 是显式弹窗开关：只有传 title 才弹；仅为无障碍命名请传 aria-label
  return (
    <ButtonTooltip label={title}>
      <button
        type="button"
        aria-label={title}
        className={cn(
          'no-drag flex shrink-0 cursor-pointer items-center justify-center outline-none transition-all duration-150',
          'active:scale-90 disabled:pointer-events-none disabled:text-muted/35',
          'focus-visible:ring-[1.5px] focus-visible:ring-at-accent/70',
          variant === 'toolbar'
            ? cn(
                'border hover:text-fg',
                selected
                  ? 'text-fg border-at-accent/45 bg-raised'
                  : cn(
                      'text-muted border-line hover:border-chrome-sep hover:bg-hover',
                      filled ? 'bg-raised' : 'bg-raised/55'
                    )
              )
            : cn(
                'hover:bg-hover/80',
                tone === 'accent'
                  ? selected
                    ? 'text-at-accent'
                    : 'text-at-accent/85 hover:text-at-accent'
                  : selected
                    ? 'text-fg'
                    : 'text-muted hover:text-fg'
              ),
          className
        )}
        style={{ width: frame, height: frame, borderRadius: cornerRadius }}
        {...rest}
      >
        <Icon size={size} strokeWidth={strokeWidth} />
      </button>
    </ButtonTooltip>
  )
}

/** 复制微钮：点击写剪贴板，成功 1s 内显示对勾（accent 常驻，与连接列表地址复制一致） */
export function CopyIconButton({
  value,
  label,
  size = 12,
  onCopied
}: {
  value: string
  label: string
  size?: number
  onCopied?: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const copy = (): void => {
    if (copied) return
    void navigator.clipboard.writeText(value).catch(() => {})
    setCopied(true)
    onCopied?.()
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1000)
  }

  return (
    <IconButton
      icon={copied ? Check : Copy}
      size={size}
      tone="accent"
      aria-label={label}
      onClick={copy}
    />
  )
}
