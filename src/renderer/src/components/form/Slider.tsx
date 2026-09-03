import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

export interface SliderProps {
  /** 受控值（拖动中父级传预览值，其余时候传持久化值） */
  value: number
  /** 拖动/按键过程中的连续取值：只做实时预览，勿在此落库 */
  onInput: (value: number) => void
  /** 取值确定（松手 / 键盘调整 / 组件卸载兜底）后触发一次：落库用 */
  onCommit?: (value: number) => void
  min?: number
  max?: number
  step?: number
  /** 无障碍名：滑杆无可见文字标签时必填（读屏用） */
  label: string
  disabled?: boolean
  className?: string
}

/**
 * 数值滑杆：原生 input[type=range] + `.range-at` 皮肤（见 assets/main.css）。
 *
 * 「预览—提交」两段式：拖动中只发 onInput，松手时才发一次 onCommit。
 * 原生 range 的每次移动都触发 input 事件，若每次直接写 store，会连带
 * 全应用重渲染 + 偏好落盘（electron-store 同步写盘）→ 拖动明显滞涩；
 * 两段式把高频路径限制在「父级直接改 CSS 变量」上。
 *
 * 进度染色经 --slider-pct 传入；轨道/thumb 尺寸约定在 CSS 内，
 * 调用点只控制宽度，勿覆写高度（否则 thumb 垂直居中失效）。
 */
export function Slider({
  value,
  onInput,
  onCommit,
  min = 0,
  max = 100,
  step = 1,
  label,
  disabled = false,
  className
}: SliderProps): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  /** 待提交值：连续输入时不断覆盖，提交后清空 —— 一次交互只落库一次 */
  const pending = useRef<number | null>(null)
  const commitRef = useRef(onCommit)
  useEffect(() => {
    commitRef.current = onCommit
  })

  /** 幂等提交：无待提交值时直接返回（change / pointerup / keyup / 卸载可能重复触发） */
  const flush = (): void => {
    const v = pending.current
    pending.current = null
    if (v !== null) commitRef.current?.(v)
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // 原生 change = 取值确定（拖动松手 / 键盘调整）的正常提交路径
    const onNativeChange = (): void => {
      pending.current = Number(el.value)
      flush()
    }
    el.addEventListener('change', onNativeChange)
    return () => {
      el.removeEventListener('change', onNativeChange)
      // 卸载兜底：拖到一半被卸载（切页/退出）不丢最后一次取值
      flush()
    }
    // flush 只依赖 ref，无需随渲染重建监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100
  return (
    <input
      ref={ref}
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onInput={(e) => {
        const v = Number(e.currentTarget.value)
        pending.current = v
        onInput(v)
      }}
      /* 兜底：change 未触发（指针在窗口外释放等）时也能提交 */
      onPointerUp={flush}
      onKeyUp={flush}
      className={cn('no-drag range-at w-full', className)}
      style={{ '--slider-pct': `${pct}%` } as React.CSSProperties}
    />
  )
}
