// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useWorkspaceClose } from '../src/renderer/src/app/useWorkspaceClose'
import { useToast } from '../src/renderer/src/app/useToast'
import { useSessionStore, type HostWorkspaceMirror } from '../src/renderer/src/stores/session'
import { useLocalTerminalStore } from '../src/renderer/src/stores/localTerminal'
import { usePrefsStore } from '../src/renderer/src/stores/prefs'
import type { AppPreferencesData } from '../src/shared/types'

const originalClose = useSessionStore.getState().closeHost
const confirmClose = vi.fn(),
  off = vi.fn()
let requestClose!: () => void
beforeEach(() => {
  vi.clearAllMocks()
  useSessionStore.setState({ hosts: [], closeHost: vi.fn() })
  useLocalTerminalStore.setState({ tabs: [] })
  usePrefsStore.setState({ data: { confirmCloseSession: false } as AppPreferencesData })
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      window: {
        confirmClose,
        onCloseRequest: vi.fn((callback) => {
          requestClose = callback
          return off
        })
      }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useSessionStore.setState({ hosts: [], closeHost: originalClose })
})

it('retains native close and reload protection for dirty or saving documents', () => {
  useSessionStore.setState({
    hosts: [
      { id: 'host', files: [{ text: 'new', saved: 'old', saving: false }] } as HostWorkspaceMirror
    ]
  })
  const { result, unmount } = renderHook(() => useWorkspaceClose())
  act(() => requestClose())
  expect(result.current.pendingClose).toEqual({ ids: ['host'], quit: true })
  expect(confirmClose).not.toHaveBeenCalled()
  const reload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(reload)
  expect(reload.defaultPrevented).toBe(true)
  unmount()
  expect(off).toHaveBeenCalledOnce()
  const after = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(after)
  expect(after.defaultPrevented).toBe(false)
})

it('preserves batch-close confirmation while allowing an unprotected native quit', () => {
  useSessionStore.setState({
    hosts: [
      { id: 'one', files: [] },
      { id: 'two', files: [] }
    ] as unknown as HostWorkspaceMirror[]
  })
  const { result, rerender } = renderHook(() => useWorkspaceClose())
  act(() => result.current.requestClose(['one', 'two']))
  expect(result.current.pendingClose).toEqual({ ids: ['one', 'two'], quit: false })
  expect(useSessionStore.getState().closeHost).not.toHaveBeenCalled()
  act(() => requestClose())
  expect(confirmClose).toHaveBeenCalledOnce()
  rerender()
  expect(window.aterm.window.onCloseRequest).toHaveBeenCalledOnce()
})

it('keeps toast callbacks stable and disposes the pending timeout on unmount', () => {
  vi.useFakeTimers()
  const { result, rerender, unmount } = renderHook(() => useToast())
  const flash = result.current.flash
  act(() => flash('First'))
  rerender()
  expect(result.current.flash).toBe(flash)
  act(() => flash('Replacement', true))
  expect(vi.getTimerCount()).toBe(1)
  expect(result.current.toast).toEqual({ text: 'Replacement', danger: true })
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})
