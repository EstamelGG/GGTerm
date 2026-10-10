// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserBookmarks } from '../src/renderer/src/components/chrome/BrowserBookmarks'
import type { BrowserBookmark } from '../src/shared/browserBookmarks'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('saves the current page, reflects Agent changes and edits the saved URL', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  HTMLElement.prototype.scrollIntoView = vi.fn()
  let changed!: (items: BrowserBookmark[]) => void
  let item: BrowserBookmark = {
    id: 'bookmark',
    title: 'Dashboard',
    url: 'https://example.com/',
    createdAt: 1,
    updatedAt: 1
  }
  const save = vi.fn(async () => {
    changed([item])
    return item
  })
  const update = vi.fn(async (_id, input) => {
    item = { ...item, ...input }
    changed([item])
    return item
  })
  Object.assign(window, {
    aterm: {
      browser: {
        bookmarks: {
          list: async () => [],
          onChanged: (cb: typeof changed) => {
            changed = cb
            return () => {}
          },
          save,
          update
        }
      }
    }
  })
  render(
    <BrowserBookmarks
      current={{
        id: 'tab',
        title: 'Dashboard',
        url: 'https://example.com/',
        loading: false,
        canGoBack: false,
        canGoForward: false
      }}
      onOpen={vi.fn()}
      onError={vi.fn()}
    />
  )
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'browser.saveBookmark' }))
  await screen.findByRole('button', { name: 'browser.editBookmark' })
  expect(save).toHaveBeenCalledWith({ title: 'Dashboard', url: 'https://example.com/' })
  await act(async () => {
    changed([{ ...item, title: 'Agent renamed' }])
  })
  fireEvent.click(screen.getByRole('button', { name: 'browser.editBookmark' }))
  const title = await screen.findByRole('textbox', { name: 'browser.bookmarkTitle' })
  expect((title as HTMLInputElement).value).toBe('Agent renamed')
  fireEvent.change(screen.getByRole('textbox', { name: 'browser.address' }), {
    target: { value: 'https://example.com/download' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith('bookmark', {
      title: 'Agent renamed',
      url: 'https://example.com/download'
    })
  )
})
