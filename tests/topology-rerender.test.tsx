// @vitest-environment jsdom
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TopologyCanvas } from '../src/renderer/src/components/ai/TopologyCanvas'
import { useTopologyGraph } from '../src/renderer/src/components/ai/topology/useTopologyGraph'
import { useConnectionsStore } from '../src/renderer/src/stores/connections'
import { useLinksStore } from '../src/renderer/src/stores/links'
import { usePerfStore } from '../src/renderer/src/stores/perf'
import type { HostConnection, HostLinkSnapshot } from '../src/shared/types'

/**
 * 「关闭一台主机连接时，图重绘到什么程度」的度量与守卫。
 *
 * 结论（实测）：关闭 A 只重绘 A 自己 —— 节点组件与边组件的重绘都按对象身份判定，
 * 其余节点/边沿用上一轮对象（useTopologyGraph 的 intern + 组件 memo 生效）。
 * 会重绘的只有「被关的那一个节点 + 它那一条边」以及拥有整图数据的画布容器本身。
 * 因此这里锁死两件事：① 数据层身份 ② 节点组件/DOM 的实际触达范围。
 */

/** 计数器：主机节点组件渲染次数（每个 host 节点渲染一次 OsIcon，按 osName 归属） */
const probe = vi.hoisted(() => ({ nodes: [] as string[], commits: 0 }))

vi.mock('../src/renderer/src/components/connection/OsIcon', () => ({
  OsIcon: ({ osName }: { osName?: string }) => {
    probe.nodes.push(osName || '(none)')
    return null
  }
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

const HOSTS = ['a', 'b', 'c'] as const
/** 用 OS 名给节点打标：重绘的是哪台，看 OsIcon 收到的 osName */
const OS: Record<string, string> = { a: 'ubuntu', b: 'debian', c: 'arch' }

function conn(id: string): HostConnection {
  return {
    id,
    name: id.toUpperCase(),
    host: `${id}.test`,
    port: 22,
    username: 'root',
    authType: 'password',
    groupId: null,
    connectTimeout: 20000,
    keepaliveInterval: 5000,
    initCommand: '',
    initDir: '',
    perfDisabled: false,
    jumpHostIds: [],
    createdAt: 0,
    updatedAt: 0
  }
}

function snap(hostId: string, phase: 'connected' | 'idle' = 'connected'): HostLinkSnapshot {
  return { hostId, phase, since: Date.now(), attempt: 0, reason: '', jumpIds: [] }
}

const noop = (): (() => void) => () => {}

beforeEach(() => {
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      hosts: {
        onState: noop,
        onAgentState: noop,
        listLinks: async () => [],
        listAgentLinks: async () => []
      },
      perf: { probeOs: () => {} },
      ai: { onEvent: noop },
      executions: { list: async () => [] }
    }
  })
  // jsdom 无 matchMedia / ResizeObserver：画布的「减少动效」判断与 fitView 调度都要用
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {}
  }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = (): void => {}
      unobserve = (): void => {}
      disconnect = (): void => {}
    }
  )
  useConnectionsStore.setState({ connections: HOSTS.map(conn), groups: [], loaded: true })
  useLinksStore.setState({ byHost: Object.fromEntries(HOSTS.map((h) => [h, snap(h)])) })
  usePerfStore.setState({ osNames: { ...OS } })
  probe.nodes.length = 0
  probe.commits = 0
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useLinksStore.setState({ byHost: {} })
})

/** 关闭 b（其余保持已连接） */
function closeB(): void {
  useLinksStore.setState({ byHost: { a: snap('a'), b: snap('b', 'idle'), c: snap('c') } })
}

async function mount(): Promise<HTMLElement> {
  const { container } = render(
    <Profiler
      id="topo"
      onRender={() => {
        probe.commits += 1
      }}
    >
      <TopologyCanvas />
    </Profiler>
  )
  await act(async () => {})
  await act(async () => {})
  return container
}

it('数据层：关闭 b 只换掉 b 的节点与边对象，其余沿用上一轮身份', () => {
  const { result } = renderHook(() => useTopologyGraph(1, 1))
  const before = new Map(result.current.nodes.map((n) => [n.id, n]))
  const edgesBefore = new Map(result.current.edges.map((e) => [e.id, e]))

  act(() => closeB())

  const keptNodes = result.current.nodes.filter((n) => before.get(n.id) === n).map((n) => n.id)
  const keptEdges = result.current.edges.filter((e) => edgesBefore.get(e.id) === e).map((e) => e.id)
  // 身份不变 = 组件 memo 必然跳过 = 不可能重绘
  expect(keptNodes).toEqual(['CENTER', 'a', 'c'])
  expect(keptEdges).toEqual(['CENTER>a', 'CENTER>c'])
})

it('组件层：关闭 b 只重绘 b 的节点组件，DOM 也只动 b', async () => {
  const container = await mount()
  probe.nodes.length = 0

  const touched: string[] = []
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target as HTMLElement
      touched.push(el.closest?.('[data-id]')?.getAttribute('data-id') ?? '(canvas)')
    }
  })
  observer.observe(container, { subtree: true, childList: true, attributes: true, characterData: true })

  await act(async () => closeB())
  await act(async () => {})
  observer.disconnect()

  // 只有 b（'debian'）重绘；a / c 零重绘
  expect(probe.nodes).toEqual(['debian'])
  // DOM 层面同样只落到 b 的子树（(canvas) = 画布自身的容器/控件，与节点无关）
  expect([...new Set(touched.filter((t) => t !== '(canvas)'))]).toEqual(['b'])
})

it('组件层：选中某节点后关闭另一台，其余节点仍不重绘（选中投影不会殃及全图）', async () => {
  const container = await mount()
  const nodeA = container.querySelector('[data-id="a"]')
  expect(nodeA).not.toBeNull()
  await act(async () => {
    fireEvent.click(nodeA as Element)
  })
  await act(async () => {})
  probe.nodes.length = 0

  await act(async () => closeB())
  await act(async () => {})

  expect(probe.nodes).toEqual(['debian'])
})

it('组件层：内容等值的链路快照不重绘任何节点（容器重渲染是这个数据链路的固定成本）', async () => {
  await mount()
  probe.nodes.length = 0
  probe.commits = 0

  await act(async () => {
    useLinksStore.setState({ byHost: Object.fromEntries(HOSTS.map((h) => [h, snap(h)])) })
  })
  await act(async () => {})

  expect(probe.nodes).toEqual([])
  // 记录现状：即使图内容零变化，容器仍会重渲染（实测 3 次提交 / 每次 links 发布）
  expect(probe.commits).toBeGreaterThan(0)
})

it('退场：环已走完并消失的节点，不会因别处断开而重新闪出', () => {
  vi.useFakeTimers()
  // a 在 10 分钟前断开（环早已走完，一上图即出场）；b 已连接
  const goneA: HostLinkSnapshot = { ...snap('a', 'idle'), since: Date.now() - 10 * 60 * 1000 }
  useLinksStore.setState({ byHost: { a: goneA, b: snap('b') } })
  const { result } = renderHook(() => useTopologyGraph(1, 1))
  const ids = (): string[] => result.current.nodes.map((n) => n.id)

  act(() => vi.advanceTimersByTime(1000))
  expect(ids()).toEqual(['CENTER', 'b'])

  // 断开 b：链路镜像整体换新 → 退场调度 effect 因此重跑。a 不得被重新排入退场，
  // 否则它会以 'out' 态重新上图、450ms 后再消失（就是「出现一下又消失」）
  act(() => {
    useLinksStore.setState({ byHost: { a: goneA, b: snap('b', 'idle') } })
  })
  act(() => vi.advanceTimersByTime(1))
  expect(ids()).toEqual(['CENTER', 'b'])
  act(() => vi.advanceTimersByTime(1000))
  expect(ids()).toEqual(['CENTER', 'b'])
  vi.useRealTimers()
})
