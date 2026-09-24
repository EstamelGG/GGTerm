import { cn } from '@/lib/utils'

/** 小开关（设置页/表单行共用） */
export function Switch({
  on,
  onChange,
  label,
  disabled
}: {
  disabled?: boolean
  label: string
  on: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={cn(
        'relative h-[18px] w-8 shrink-0 cursor-pointer rounded-full transition-all duration-150 outline-none focus-visible:ring-[1.5px] focus-visible:ring-at-accent/70 active:scale-95',
        on ? 'bg-at-accent' : 'bg-muted/35'
      )}
      onClick={() => onChange(!on)}
    >
      <span
        className={cn(
          'absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all duration-150',
          on ? 'left-[16px]' : 'left-[2px]'
        )}
      />
    </button>
  )
}
