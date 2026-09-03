// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { useLatencyStore } from '../src/renderer/src/stores/latency'

it('updates each host independently: first reply shows immediately, existing values are kept', async () => {
  const replies: Array<(value: { id: string; ms: number | null }[]) => void> = []
  const latency = vi.fn(
    () => new Promise<{ id: string; ms: number | null }[]>((resolve) => replies.push(resolve))
  )
  Object.defineProperty(window, 'aterm', { configurable: true, value: { probe: { latency } } })
  useLatencyStore.setState({ status: {} })
  const targets = ['fast', 'slow'].map((id) => ({ id, host: id, port: 22 }))

  // 第一轮：两台并发；先到的先上屏，不等另一台
  useLatencyStore.getState().refresh(targets)
  expect(latency).toHaveBeenCalledTimes(2)
  replies[0]([{ id: 'fast', ms: 5 }])
  await Promise.resolve()
  expect(useLatencyStore.getState().status).toEqual({ fast: 5, slow: 'probing' })

  // 第二轮：重测保留已有结果（不被清回 probing）
  useLatencyStore.getState().refresh(targets)
  expect(useLatencyStore.getState().status.fast).toBe(5)
  replies[3]([{ id: 'slow', ms: 999 }])
  await Promise.resolve()
  expect(useLatencyStore.getState().status).toEqual({ fast: 5, slow: 999 })

  // 不可达回包 → unreachable
  useLatencyStore.getState().refresh(targets)
  replies[5]([{ id: 'slow', ms: null }])
  await Promise.resolve()
  expect(useLatencyStore.getState().status).toEqual({ fast: 5, slow: 'unreachable' })
})
