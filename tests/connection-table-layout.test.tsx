// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectionTable } from '../src/renderer/src/components/connection/ConnectionTable'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('restores columns on activation without waiting for ResizeObserver', () => {
  let width = 600
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  const observers: Array<() => void> = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observers.push(callback)
      }
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  // 行级可见性驱动用 IO；jsdom 不提供，stub 掉（本用例只验证列宽恢复逻辑）
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      perf: { watch: vi.fn(), setPaused: vi.fn() }
    }
  })
  const noop = (): void => {}
  const props = {
    perfEnabled: true,
    connections: [],
    sortColumn: 'name' as const,
    sortAscending: true,
    onToggleSort: noop,
    onConnect: noop,
    onEdit: noop,
    onCopyAddress: noop,
    onDuplicate: noop,
    onDelete: noop,
    onToast: noop,
    selectedIds: new Set<string>(),
    onToggleSelect: noop,
    onToggleSelectAll: noop
  }
  const { rerender } = render(<ConnectionTable {...props} active />)
  expect(screen.queryByText('conn.col.perf')).toBeNull()
  width = 0
  rerender(<ConnectionTable {...props} active={false} />)
  // The window grows while another page is active; observers deliberately never fire.
  width = 1200
  rerender(<ConnectionTable {...props} active />)
  expect(screen.queryByText(/conn.col.perf/)).not.toBeNull()
  expect(screen.queryByText('conn.live.title')).not.toBeNull()
  expect(screen.queryByText('conn.col.remark')).toBeNull()
  width = 0
  rerender(<ConnectionTable {...props} active={false} />)
  expect(screen.queryByText(/conn.col.perf/)).not.toBeNull()
  width = 600
  rerender(<ConnectionTable {...props} active />)
  expect(screen.queryByText('conn.col.perf')).toBeNull()
  expect(observers.length).toBeGreaterThan(0)
})
