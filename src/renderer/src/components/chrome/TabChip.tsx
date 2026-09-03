import type { LucideIcon } from 'lucide-react'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/IconButton'
import { StateDot } from '@/components/ui/StateDot'
import type { StateDotVisual } from '@/lib/linkPhase'

interface TabChipProps {
  title: string
  icon?: LucideIcon
  /** 状态点视觉（lib/linkPhase 工厂产出：linkStateDot / shellStateDot / solidDot） */
  statusColor?: StateDotVisual
  selected: boolean
  accentBorder?: boolean
  showClose?: boolean
  onClick?: () => void
  onClose?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  children?: ReactNode
  /** 标题文本色（如主机 tab 的分组色；缺省沿用选中/未选中配色） */
  titleColor?: string
  /** chip 整体最大宽度（px）；标题超宽自动截断省略号 */
  maxWidth?: number
}

/** 对照 ATerminal-Swift WindowChrome.swift TabChip */
export function TabChip({
  title,
  icon: Icon,
  statusColor,
  selected,
  accentBorder = true,
  showClose = false,
  onClick,
  onClose,
  onContextMenu,
  children,
  titleColor,
  maxWidth
}: TabChipProps): React.JSX.Element {
  const chipFill = selected ? 'bg-raised' : 'bg-raised/45 hover:bg-hover/70'
  const chipBorder = cn(
    'border',
    accentBorder && selected ? 'border-at-accent/45' : 'border-line hover:border-chrome-sep'
  )

  return (
    <div
      className={cn(
        'no-drag flex min-h-6 shrink-0 items-center rounded-full transition-colors duration-100',
        chipFill,
        chipBorder
      )}
      style={maxWidth !== undefined ? { maxWidth } : undefined}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        className={cn(
          'flex cursor-pointer items-center gap-1.5 rounded-full py-[3px] pl-2.5 outline-none',
          showClose ? 'pr-0.5' : 'pr-2.5'
        )}
        onClick={onClick}
      >
        {Icon && (
          <Icon size={11} strokeWidth={2.2} className={selected ? 'text-fg' : 'text-muted'} />
        )}
        {statusColor && <StateDot visual={statusColor} />}
        <span
          className={cn(
            'min-w-0 max-w-48 truncate font-medium text-minor leading-5',
            selected ? 'text-fg' : 'text-muted'
          )}
          style={titleColor ? { color: titleColor } : undefined}
        >
          {title}
        </span>
        {children}
      </button>
      {showClose && onClose && <CloseChipButton onClick={onClose} />}
    </div>
  )
}

function CloseChipButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <IconButton
      icon={X}
      aria-label={t('common.close')}
      size={8}
      frame={22}
      cornerRadius={11}
      strokeWidth={3}
      className="mr-1"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    />
  )
}

/**
 * 标签条横向滚动区（shell / 文件 / 本地控制台 / 主机条共用）：
 * - chips 在此横向滚动（触控板手势），'+' 等行尾按钮留在容器外不随滚走、永不越界
 * - 点击任一标签（含关闭钮）捕获阶段把所属 chip 滚入可视区，越界标签点击即可见
 */
export function TabScrollArea({
  className,
  children
}: {
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-none',
        className
      )}
      onClickCapture={(e) => {
        const chip = (e.target as HTMLElement).closest('button')
        chip?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
      }}
    >
      {children}
    </div>
  )
}
