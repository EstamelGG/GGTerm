import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi, type Mock } from 'vitest'
import type { BrowserWindow } from 'electron'
const state = vi.hoisted(() => ({ supported: true, instances: [] as EventEmitter[] }))
vi.mock('electron', () => ({
  Notification: class extends EventEmitter {
    static isSupported = (): boolean => state.supported
    show = vi.fn()
    close = vi.fn()
    constructor(public options: unknown) {
      super()
      state.instances.push(this)
    }
  }
}))
import { clearBrowserAttention, notifyBrowserAttention } from '../src/main/browserAttention'
interface WindowMock {
  isDestroyed: Mock<() => boolean>
  isFocused: Mock<() => boolean>
  isMinimized: Mock<() => boolean>
  restore: Mock<() => void>
  show: Mock<() => void>
  focus: Mock<() => void>
}
const makeWindow = (): WindowMock => ({
  isDestroyed: vi.fn(() => false),
  isFocused: vi.fn(() => false),
  isMinimized: vi.fn(() => false),
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn()
})
beforeEach(() => {
  clearBrowserAttention()
  state.instances = []
  state.supported = true
})
it('notifies once without raising the app; only a notification click activates it', () => {
  const window = makeWindow()
  const select = vi.fn(() => true)
  const notify = (): void =>
    notifyBrowserAttention(window as unknown as BrowserWindow, 'tab:cert', 'Review', 'Host', select)
  notify()
  notify()
  expect(state.instances).toHaveLength(1)
  expect(window.show).not.toHaveBeenCalled()
  expect(window.focus).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
  state.instances[0].emit('click')
  expect(select).toHaveBeenCalledOnce()
  expect(window.show).toHaveBeenCalledOnce()
  expect(window.focus).toHaveBeenCalledOnce()
})
it('unsupported notifications never fall back to focusing', () => {
  state.supported = false
  const window = makeWindow()
  notifyBrowserAttention(
    window as unknown as BrowserWindow,
    'tab:cert',
    'Review',
    'Host',
    () => true
  )
  expect(state.instances).toHaveLength(0)
  expect(window.focus).not.toHaveBeenCalled()
})
it('dismissed notifications remain deduplicated, clearing a tab allows a new notice', () => {
  const window = makeWindow()
  const notify = (): void =>
    notifyBrowserAttention(
      window as unknown as BrowserWindow,
      'tab:cert',
      'Review',
      'Host',
      () => true
    )
  notify()
  state.instances[0].emit('close')
  notify()
  expect(state.instances).toHaveLength(1)
  clearBrowserAttention('tab:')
  notify()
  expect(state.instances).toHaveLength(2)
})
it('obsolete requests and destroyed windows cannot activate on click', () => {
  const window = makeWindow()
  notifyBrowserAttention(
    window as unknown as BrowserWindow,
    'tab:cert',
    'Review',
    'Host',
    () => false
  )
  state.instances[0].emit('click')
  expect(window.focus).not.toHaveBeenCalled()
  window.isDestroyed.mockReturnValue(true)
  state.instances[0].emit('click')
  expect(window.show).not.toHaveBeenCalled()
})
it('focused applications do not generate system notices', () => {
  const window = makeWindow()
  window.isFocused.mockReturnValue(true)
  notifyBrowserAttention(
    window as unknown as BrowserWindow,
    'tab:cert',
    'Review',
    'Host',
    () => true
  )
  expect(state.instances).toHaveLength(0)
})
