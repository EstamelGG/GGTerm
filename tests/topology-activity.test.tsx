// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useTopologyGraph } from '../src/renderer/src/components/ai/topology/useTopologyGraph'
import { useLinksStore } from '../src/renderer/src/stores/links'
import { usePerfStore } from '../src/renderer/src/stores/perf'
import type { AiEvent } from '../src/shared/types'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useLinksStore.setState({ byHost: {} })
})

it('lights the resolved remote host and cancels stale fade timers on subsequent commands', async () => {
  vi.useFakeTimers()
  let listener!: (event: AiEvent) => void
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      hosts: { onState: () => () => {}, onAgentState: () => () => {} },
      // execute 按 executionId 操作：主机经该会话的执行记录反查
      executions: { list: async () => [{ executionId: 'shell', hostId: 'remote' }] },
      ai: {
        onEvent: (callback: typeof listener) => {
          listener = callback
          return () => {}
        }
      }
    }
  })
  useLinksStore.setState({
    byHost: { remote: { hostId: 'remote', phase: 'connected', since: Date.now() } }
  })
  const { result } = renderHook(() => useTopologyGraph(1, 1))
  const start = (id: string, sessionId = 'owner'): Promise<void> =>
    act(async () => {
      listener({
        type: 'chunk',
        sessionId,
        chunk: {
          type: 'tool-input-available',
          toolCallId: id,
          toolName: 'execute',
          input: { action: 'input', executionId: 'shell' }
        }
      })
    })
  const finish = (id: string, sessionId = 'owner'): void =>
    act(() =>
      listener({
        type: 'chunk',
        sessionId,
        chunk: { type: 'tool-output-available', toolCallId: id, output: {} }
      })
    )
  const host = (): (typeof result.current.nodes)[number]['data'] =>
    result.current.nodes.find((n) => n.id === 'remote')!.data
  await start('first')
  expect(host().active).toBe(true)
  expect(result.current.edges[0].data?.state).toBe('working')
  expect(result.current.nodes[0].data.active).toBe(false)
  finish('first')
  act(() => vi.advanceTimersByTime(3000))
  expect(host().settling).toBe(true)
  await start('second')
  act(() => vi.advanceTimersByTime(500))
  expect(host().active).toBe(true)
  expect(host().settling).toBe(false)
  await start('second', 'another-owner')
  finish('second')
  act(() => vi.advanceTimersByTime(4000))
  expect(host().settling).toBe(false)
  finish('second', 'another-owner')
  act(() => vi.advanceTimersByTime(3500))
  expect(host().active).toBe(false)
})

it('性能采样与等值链路事件不再引发拓扑重绘（节点/边对象身份稳定）', () => {
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      hosts: { onState: () => () => {}, onAgentState: () => () => {} },
      perf: { probeOs: () => {} },
      ai: { onEvent: () => () => {} },
      executions: { list: async () => [] }
    }
  })
  const link = {
    hostId: 'remote',
    phase: 'connected' as const,
    since: Date.now(),
    attempt: 0,
    reason: '',
    jumpIds: []
  }
  useLinksStore.setState({ byHost: { remote: link } })
  const { result } = renderHook(() => useTopologyGraph(1, 1))

  const center = result.current.nodes[0]
  const remote = result.current.nodes[1]
  const edge = result.current.edges[0]

  // ① 主进程 3s 一轮的性能采样：图只消费其中的 OS 名，本样本 osName 为空（不改变缓存）→ 应零重绘
  act(() => {
    usePerfStore.getState().apply({
      hostId: 'remote',
      cores: 4,
      cpuPct: 12,
      memTotal: 1024,
      memPct: 10,
      diskTotal: 1024,
      diskPct: 10,
      swapTotal: 0,
      swapPct: null,
      netRx: 1,
      netTx: 2,
      load1: null,
      load5: null,
      load15: null,
      procsRun: null,
      procsTotal: null,
      uptimeSec: null,
      osName: '',
      timezone: '',
      memFree: 0,
      memCache: 0,
      perCore: [],
      disks: [],
      t: Date.now()
    })
  })
  expect(result.current.nodes[0]).toBe(center)
  expect(result.current.nodes[1]).toBe(remote)
  expect(result.current.edges[0]).toBe(edge)

  // ② 链路镜像整体换新但内容等值（同相位重复广播）：数据与位置都未变，同样复用对象
  act(() => {
    useLinksStore.setState({ byHost: { remote: { ...link } } })
  })
  expect(result.current.nodes[1]).toBe(remote)
  expect(result.current.edges[0]).toBe(edge)
})
