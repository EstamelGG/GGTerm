import { useFieldLabel } from './FieldContext'
import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/IconButton'

/** 对照 WindowChrome.swift SecretField：密码输入 + 明/密文切换 */
export function SecretField({
  value,
  onChange,
  placeholder = '',
  revealTitle,
  hideTitle,
  onKeyDown,
  className
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  revealTitle?: string
  hideTitle?: string
  /** 键盘事件透传（如会话卡内 ⏎ 直接提交、Esc 清空） */
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void
  className?: string
}): React.JSX.Element {
  const labelId = useFieldLabel()
  const { t } = useTranslation()
  const [revealed, setRevealed] = useState(false)
  return (
    <div
      className={cn(
        'no-drag flex h-8 items-center gap-1.5 rounded-lg border border-line bg-raised pl-2.5 pr-1 transition-colors duration-100 focus-within:border-at-accent/50',
        className
      )}
    >
      <input
        aria-labelledby={labelId}
        type={revealed ? 'text' : 'password'}
        className="h-full min-w-0 flex-1 bg-transparent text-body text-fg placeholder:text-muted outline-none"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <IconButton
        icon={revealed ? EyeOff : Eye}
        size={11}
        frame={22}
        selected={revealed}
        aria-label={
          revealed ? (hideTitle ?? t('form.hidePassword')) : (revealTitle ?? t('form.showPassword'))
        }
        onClick={() => setRevealed((v) => !v)}
      />
    </div>
  )
}

/** 对照 WindowChrome.swift SecretEditor：多行等宽密钥编辑器 + 占位符 */
export function SecretEditor({
  value,
  onChange,
  placeholder,
  minHeight = 72,
  className
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  minHeight?: number
  className?: string
}): React.JSX.Element {
  const labelId = useFieldLabel()
  return (
    <div className={cn('relative', className)}>
      {value === '' && (
        <span className="pointer-events-none absolute left-2.5 top-2.5 font-mono text-minor text-muted">
          {placeholder}
        </span>
      )}
      <textarea
        aria-labelledby={labelId}
        className="no-drag w-full resize-none rounded-lg border border-line bg-raised px-2.5 py-2 font-mono text-minor text-fg outline-none transition-colors duration-100 focus:border-at-accent/50"
        style={{ minHeight }}
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}
