// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { StateDot } from '../src/renderer/src/components/ui/StateDot'
import { TabChip } from '../src/renderer/src/components/chrome/TabChip'
import { linkStateDot, shellStateDot, solidDot } from '../src/renderer/src/lib/linkPhase'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

afterEach(cleanup)

const cls = (visual: Parameters<typeof StateDot>[0]['visual']): string =>
  (render(<StateDot visual={visual} />).container.firstChild as HTMLElement).className

it('connecting → 挂载闪烁动画类 + 基础类完整', () => {
  const c = cls(linkStateDot('connecting'))
  expect(c).toContain('animate-[state-dot-blink_0.9s_ease-in-out_infinite]')
  expect(c).toContain('transition-colors')
})

it('reconnecting → 同样闪烁', () => {
  expect(cls(linkStateDot('reconnecting'))).toContain(
    'animate-[state-dot-blink_0.9s_ease-in-out_infinite]'
  )
})

it('connected → 实心、不闪', () => {
  const c = cls(linkStateDot('connected'))
  expect(c).not.toContain('animate-')
  expect(c).toContain('rounded-full')
})

it('undefined / idle → 空心、不闪', () => {
  for (const phase of [undefined, 'idle'] as const) {
    const visual = linkStateDot(phase)
    expect(visual.filled).toBe(false)
    expect(visual.pulsing).toBe(false)
    const el = render(<StateDot visual={visual} />).container.firstChild as HTMLElement
    expect(el.style.backgroundColor).toBe('transparent')
  }
})

it('offline → 实心红、不闪', () => {
  const visual = linkStateDot('offline')
  expect(visual).toEqual({ color: 'var(--at-danger)', filled: true, pulsing: false })
})

it('shellStateDot：connecting 闪烁；disconnected/ended/无 shell 空心', () => {
  expect(shellStateDot('connecting')).toMatchObject({ pulsing: true, filled: true })
  expect(shellStateDot('connected')).toMatchObject({ pulsing: false, filled: true })
  expect(shellStateDot('error')).toMatchObject({ color: 'var(--at-danger)', pulsing: false })
  for (const status of ['disconnected', 'ended', undefined] as const) {
    expect(shellStateDot(status)).toMatchObject({ filled: false, pulsing: false })
  }
})

it('solidDot → 常显实心', () => {
  expect(solidDot('#fff')).toEqual({ color: '#fff', filled: true, pulsing: false })
})

/** header 标签页圆点路径：TabChip.statusColor → StateDot */
const tabDotClass = (visual: Parameters<typeof StateDot>[0]['visual']): string => {
  const { container } = render(<TabChip title="Host A" statusColor={visual} selected={false} />)
  return (container.querySelector('span[style]') as HTMLElement).className
}

it('header tab 圆点：connecting 挂闪烁动画', () => {
  expect(tabDotClass(shellStateDot('connecting'))).toContain(
    'animate-[state-dot-blink_0.9s_ease-in-out_infinite]'
  )
})

it('header tab 圆点：断开 = 空心且不闪；已连接 = 实心不闪', () => {
  const idle = tabDotClass(shellStateDot('disconnected'))
  expect(idle).toContain('border')
  expect(idle).not.toContain('animate-')
  expect(tabDotClass(shellStateDot('connected'))).not.toContain('animate-')
})
