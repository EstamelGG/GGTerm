// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserPage } from '../src/renderer/src/pages/BrowserPage'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('creates and selects a blank tab from the open result even without a state event', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        return undefined
      }
      disconnect(): void {
        return undefined
      }
    }
  )
  HTMLElement.prototype.scrollIntoView = vi.fn()
  const newTab = vi.fn(async () => ({
    id: 'initial',
    url: 'about:blank',
    title: 'about:blank',
    loading: false,
    canGoBack: false,
    canGoForward: false
  }))
  const open = vi.fn(async () => ({
    id: 'new',
    url: 'about:blank',
    title: 'about:blank',
    loading: false,
    canGoBack: false,
    canGoForward: false
  }))
  Object.assign(window, {
    aterm: {
      browser: {
        list: async () => ({ tabs: [], foregroundId: null }),
        onChanged: () => () => {},
        onShow: () => () => {},
        layout: async () => {},
        open,
        newTab
      }
    }
  })
  render(
    <BrowserPage
      active
      obscured={false}
      onToast={vi.fn()}
      notification={null}
      onDismissNotification={vi.fn()}
    />
  )
  await screen.findByRole('button', { name: 'common.close' })
  expect(newTab).toHaveBeenCalledExactlyOnceWith(false)
  fireEvent.click(screen.getByRole('button', { name: 'browser.newTab' }))
  expect(open).toHaveBeenCalledWith('about:blank')
  await screen.findAllByRole('button', { name: 'browser.blankTab' })
  expect(screen.getAllByRole('button', { name: 'common.close' })).toHaveLength(2)
})
