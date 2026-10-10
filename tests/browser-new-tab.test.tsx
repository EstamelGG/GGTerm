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
        bookmarks: { list: async () => [], onChanged: () => () => {} },
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
it('shows a ready document while images are still loading', async () => {
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
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 100,
    top: 100,
    left: 0,
    right: 800,
    bottom: 700,
    width: 800,
    height: 600,
    toJSON: () => ({})
  })
  const layout = vi.fn(async () => {})
  Object.assign(window, {
    aterm: {
      browser: {
        bookmarks: { list: async () => [], onChanged: () => () => {} },
        list: async () => ({
          foregroundId: 'ready',
          tabs: [
            {
              id: 'ready',
              url: 'https://example.com/',
              title: 'Usable page',
              ready: true,
              loading: true,
              canGoBack: false,
              canGoForward: false
            }
          ]
        }),
        onChanged: () => () => {},
        onShow: () => () => {},
        layout,
        preview: async () => null
      }
    }
  })
  try {
    render(
      <BrowserPage
        active
        obscured={false}
        onToast={vi.fn()}
        notification={null}
        onDismissNotification={vi.fn()}
      />
    )
    await screen.findByRole('button', { name: 'Usable page' })
    expect(screen.queryByText('browser.loading')).toBeNull()
    const { waitFor } = await import('@testing-library/react')
    await waitFor(() =>
      expect(layout).toHaveBeenCalledWith(
        'ready',
        expect.objectContaining({ width: 800, height: 600 })
      )
    )
  } finally {
    cleanup()
    rect.mockRestore()
  }
})
