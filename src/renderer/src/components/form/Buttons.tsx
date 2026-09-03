import { useId, type ReactNode } from 'react'
import { FieldContext } from './FieldContext'
import { cn } from '@/lib/utils'

const pillBase =
  'no-drag cursor-pointer rounded-full px-3.5 py-1 leading-5 text-body transition-all duration-150 outline-none active:scale-[0.98] disabled:pointer-events-none focus-visible:ring-[1.5px]'
const variants = {
  accent:
    'bg-at-accent font-semibold text-white hover:bg-at-accent-dim disabled:bg-at-accent/35 focus-visible:ring-white/80',
  danger:
    'bg-danger font-semibold text-white hover:brightness-110 disabled:bg-danger/35 focus-visible:ring-white/80',
  ghost:
    'border border-line bg-raised font-medium text-fg hover:bg-hover disabled:opacity-35 focus-visible:ring-at-accent/70',
  text: 'no-drag cursor-pointer rounded-md px-2 py-[3px] text-caption font-medium text-muted transition-colors duration-150 outline-none hover:bg-hover/55 hover:text-fg focus-visible:ring-[1.5px] focus-visible:ring-at-accent/70 disabled:pointer-events-none disabled:opacity-40'
}

// 连接测试按钮包含图标和动态状态文字，复用同一基础样式。
export const ghostPillCls = `${pillBase} ${variants.ghost}`

export function Button({
  title,
  disabled = false,
  size = 'md',
  className,
  onClick,
  variant = 'accent'
}: {
  title: string
  disabled?: boolean
  size?: 'md' | 'sm'
  className?: string
  onClick?: () => void
  variant?: keyof typeof variants
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        variant !== 'text' && pillBase,
        variants[variant],
        size === 'sm' && 'h-6 px-3 py-0 text-minor',
        className
      )}
    >
      {title}
    </button>
  )
}

/** 字段标题 + 内容（表单字段块统一行距）；hint 渲染在标题右侧同一行 */
export function ATField({
  title,
  hint,
  children,
  className,
  required = false
}: {
  title: string
  hint?: ReactNode
  children: ReactNode
  className?: string
  required?: boolean
}): React.JSX.Element {
  const labelId = useId()
  return (
    <FieldContext.Provider value={labelId}>
      <div className={cn('flex flex-col gap-[5px]', className)}>
        <span className="flex items-center gap-2">
          <span id={labelId} className="text-caption font-medium text-muted">
            {title}
            {required && <span className="ml-1 text-danger">*</span>}
          </span>
          {hint}
        </span>
        {children}
      </div>
    </FieldContext.Provider>
  )
}
