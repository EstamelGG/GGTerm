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
        turnId: 'turn',
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
        turnId: 'turn',
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

/**
 * 审批链路（gate 判成 user-approval）：
 *   tool-input-available → tool-approval-request → 回合结束（等用户作答）→ 写回后 start 续跑 → 结果
 * 期望：等待期间连线与节点转琥珀（pending），回合结束不得把它清掉，续跑帧起恢复蓝色操作态。
 */
it('manual approval turns the link amber until the turn resumes', async () => {
  vi.useFakeTimers()
  let listener!: (event: AiEvent) => void
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      hosts: { onState: () => () => {}, onAgentState: () => () => {} },
      executions: { list: async () => [] },
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
  const host = (): (typeof result.current.nodes)[number]['data'] =>
    result.current.nodes.find((n) => n.id === 'remote')!.data
  const edge = (): string | undefined => result.current.edges[0].data?.state

  act(() => {
    listener({
      type: 'chunk',
      sessionId: 'owner',
      chunk: {
        type: 'tool-input-available',
        toolCallId: 'call-1',
        toolName: 'sftp_list',
        input: { hostId: 'remote' }
      }
    })
  })
  expect(edge()).toBe('working')
  expect(host().pending).toBe(false)

  // 人工审批请求：连线/光环转琥珀（isAutomatic 缺省 = 要人确认）
  act(() => {
    listener({
      type: 'chunk',
      sessionId: 'owner',
      chunk: { type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'call-1' }
    })
  })
  expect(edge()).toBe('pending')
  expect(host().pending).toBe(true)
  expect(host().active).toBe(true)

  // 审批请求会结束本次回合（等用户作答）：等待态必须跨回合存活
  act(() => listener({ type: 'turn-end', sessionId: 'owner' }))
  expect(edge()).toBe('pending')
  expect(host().pending).toBe(true)

  // 用户写回响应 → 自动续跑，新回合以 start 开篇：撤销琥珀，回到蓝色操作态
  act(() => {
    listener({ type: 'chunk', sessionId: 'owner', chunk: { type: 'start', messageId: 'm-1' } })
  })
  expect(edge()).toBe('working')
  expect(host().pending).toBe(false)

  // 结果落地 → 最短展示时长后淡出
  act(() => {
    listener({
      type: 'chunk',
      sessionId: 'owner',
      chunk: { type: 'tool-output-available', toolCallId: 'call-1', output: {} }
    })
  })
  act(() => vi.advanceTimersByTime(3000))
  expect(host().settling).toBe(true)
  act(() => vi.advanceTimersByTime(500))
  expect(host().active).toBe(false)
})

/** 自动通道（gate 直接 approved/denied）：不进等待态，且被自动拦截的调用要能收尾（不再一直亮着） */
it('automatic approval stays blue and an auto-denied call stops the pulse', () => {
  vi.useFakeTimers()
  let listener!: (event: AiEvent) => void
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      hosts: { onState: () => () => {}, onAgentState: () => () => {} },
      executions: { list: async () => [] },
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
  const host = (): (typeof result.current.nodes)[number]['data'] =>
    result.current.nodes.find((n) => n.id === 'remote')!.data

  act(() => {
    listener({
      type: 'chunk',
      sessionId: 'owner',
      chunk: {
        type: 'tool-input-available',
        toolCallId: 'call-2',
        toolName: 'execute',
        input: { hostId: 'remote' }
      }
    })
  })
  act(() => {
    listener({
      type: 'chunk',
      sessionId: 'owner',
      chunk: {
        type: 'tool-approval-request',
        approvalId: 'ap-2',
        toolCallId: 'call-2',
        isAutomatic: true
      }
    })
  })
  expect(result.current.edges[0].data?.state).toBe('working')
  expect(host().pending).toBe(false)

  // 自动拦截：该调用不会再有结果，应答流片即收尾
  act(() => {
    listener({
      type: 'chunk',
      sessionId: 'owner',
      chunk: { type: 'tool-approval-response', approvalId: 'ap-2', approved: false }
    })
  })
  act(() => vi.advanceTimersByTime(3000))
  expect(host().settling).toBe(true)
  act(() => vi.advanceTimersByTime(500))
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
