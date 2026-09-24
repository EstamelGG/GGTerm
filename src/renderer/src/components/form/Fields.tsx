import { useFieldLabel } from './FieldContext'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

const fieldBase =
  'no-drag w-full rounded-lg border border-line bg-raised px-2.5 text-body text-fg placeholder:text-muted outline-none focus:border-at-accent/50 transition-colors duration-100'

/** 单行输入（raised 底 + line 边 + r7）；支持 autoFocus/onKeyDown 透传（弹窗内回车提交）、disabled */
export function ATTextField({
  value,
  onChange,
  placeholder = '',
  className,
  autoFocus,
  onKeyDown,
  disabled
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
  disabled?: boolean
}): React.JSX.Element {
  const labelId = useFieldLabel()
  return (
    <input
      aria-labelledby={labelId}
      type="text"
      className={cn(fieldBase, 'h-8', disabled && 'cursor-not-allowed opacity-45', className)}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onKeyDown={onKeyDown}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/** 数字输入（端口/超时/保活共用同一外观） */
export function ATNumberField({
  value,
  onChange,
  className
}: {
  value: number
  onChange: (v: number) => void
  className?: string
}): React.JSX.Element {
  const labelId = useFieldLabel()
  return (
    <input
      aria-labelledby={labelId}
      type="number"
      className={cn(fieldBase, 'h-8 px-2', className)}
      value={Number.isFinite(value) ? value : ''}
      onChange={(e) => onChange(e.target.valueAsNumber)}
    />
  )
}

/** 多行文本 + 占位符浮层 */
export function ATTextArea({
  value,
  onChange,
  placeholder = '',
  minHeight = 56,
  disabled,
  className
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
  minHeight?: number
  className?: string
}): React.JSX.Element {
  const labelId = useFieldLabel()
  return (
    <div className={cn('relative', className)}>
      {value === '' && placeholder && (
        <span className="pointer-events-none absolute left-3.5 top-2.5 text-body text-muted">
          {placeholder}
        </span>
      )}
      <textarea
        disabled={disabled}
        aria-labelledby={labelId}
        className={cn(fieldBase, 'resize-none py-2')}
        style={{ minHeight }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

/**
 * 三态勾选框（纯展示件；收编 SshConfigImport / ConnectionTable / HostSessionPage 三份拷贝）。
 * 外层点击逻辑由调用方包 button 承担（表格行、导入行、保存密码标签）。
 */
export function CheckBox({
  state = 'off',
  className
}: {
  state?: 'off' | 'on' | 'some'
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-100',
        state === 'off' ? 'border-line bg-raised' : 'border-at-accent bg-at-accent',
        className
      )}
    >
      {state === 'on' && <Check size={10} strokeWidth={3} className="text-white" />}
      {state === 'some' && <span className="h-[2px] w-[7px] rounded-full bg-white" />}
    </span>
  )
}
