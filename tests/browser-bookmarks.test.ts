import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  stores: new Map<string, Record<string, unknown>>(),
  tabs: [] as { id: string; title: string; url: string }[],
  open: vi.fn(),
  show: vi.fn()
}))
vi.mock('electron-store', () => ({
  default: class {
    name: string
    constructor(config: { name: string; defaults: Record<string, unknown> }) {
      this.name = config.name
      if (!state.stores.has(this.name))
        state.stores.set(this.name, structuredClone(config.defaults))
    }
    get(key: string): unknown {
      return structuredClone(state.stores.get(this.name)![key])
    }
    set(key: string, value: unknown): void {
      state.stores.get(this.name)![key] = structuredClone(value)
    }
  }
}))
vi.mock('../src/main/browser', () => ({
  browserState: () => ({ tabs: state.tabs }),
  openBrowser: state.open,
  showBrowser: state.show
}))
vi.mock('../src/main/ai/tools/shared', async () => {
  const { z } = await import('zod')
  return {
    defineTool: (name: string, definition: object) => ({ name, ...definition }),
    intentSchema: z.string().optional()
  }
})
beforeEach(() => {
  state.stores.clear()
  state.tabs = []
  state.open.mockReset()
  state.show.mockReset()
  vi.resetModules()
})
it('persists bookmarks, deduplicates normalized URLs, searches and edits with stable IDs', async () => {
  const api = await import('../src/main/data/browserBookmarks')
  const item = api.saveBrowserBookmark({ title: '下载任务', url: 'https://example.com' })
  expect(api.saveBrowserBookmark({ title: '下载进度', url: 'https://example.com/' }).id).toBe(
    item.id
  )
  expect(api.listBrowserBookmarks()).toHaveLength(1)
  expect(api.listBrowserBookmarks('下载')[0].title).toBe('下载进度')
  expect(api.listBrowserBookmarks('EXAMPLE.COM')).toHaveLength(1)
  api.updateBrowserBookmark(item.id, { url: 'https://example.com/download' })
  vi.resetModules()
  const restored = await import('../src/main/data/browserBookmarks')
  expect(restored.getBrowserBookmark(item.id).url).toBe('https://example.com/download')
  expect(restored.getBrowserBookmark(item.id).createdAt).toBe(item.createdAt)
  restored.deleteBrowserBookmark(item.id)
  expect(restored.listBrowserBookmarks()).toEqual([])
})
it('rejects invalid URLs, empty updates and duplicate edits without changing the store', async () => {
  const api = await import('../src/main/data/browserBookmarks')
  for (const url of ['about:blank', 'file:///tmp/file', 'javascript:alert(1)', 'bad-url'])
    expect(() => api.saveBrowserBookmark({ url })).toThrow()
  const first = api.saveBrowserBookmark({ url: 'https://example.com/a' })
  api.saveBrowserBookmark({ url: 'https://example.com/b' })
  expect(() => api.updateBrowserBookmark(first.id, {})).toThrow()
  expect(() => api.updateBrowserBookmark(first.id, { url: 'https://example.com/b' })).toThrow()
  expect(api.getBrowserBookmark(first.id).url).toBe('https://example.com/a')
})
it('publishes user and Agent edits to the same bookmark subscribers', async () => {
  const api = await import('../src/main/data/browserBookmarks')
  const changed = vi.fn()
  const off = api.onBrowserBookmarksChanged(changed)
  const bookmark = api.saveBrowserBookmark({ url: 'https://example.com' })
  const { browserBookmarkTools } = await import('../src/main/ai/tools/browserBookmarks')
  const tool = browserBookmarkTools[0]
  await tool.handler(
    { action: 'update', bookmarkId: bookmark.id, title: 'Agent edited' },
    { sessionId: 'test', signal: new AbortController().signal }
  )
  expect(changed).toHaveBeenLastCalledWith([expect.objectContaining({ title: 'Agent edited' })])
  off()
  api.deleteBrowserBookmark(bookmark.id)
  expect(changed).toHaveBeenCalledTimes(2)
})
it('lets Agent save a tab and reopen its bookmark in the background while reusing matching tabs', async () => {
  state.tabs = [{ id: 'tab', title: 'Dashboard', url: 'https://example.com/dashboard' }]
  const { browserBookmarkTools } = await import('../src/main/ai/tools/browserBookmarks')
  const tool = browserBookmarkTools[0]
  const invocation = { sessionId: 'test', signal: new AbortController().signal }
  const bookmark = (await tool.handler({ action: 'save', tabId: 'tab' }, invocation)) as {
    id: string
  }
  const opened = await tool.handler({ action: 'open', bookmarkId: bookmark.id }, invocation)
  expect(opened).toMatchObject({ tabId: 'tab' })
  expect(state.open).not.toHaveBeenCalled()
  expect(state.show).not.toHaveBeenCalled()
  await tool.handler({ action: 'open', bookmarkId: bookmark.id, foreground: true }, invocation)
  expect(state.show).toHaveBeenCalledWith('tab')
  state.tabs = []
  state.open.mockResolvedValue({ id: 'new', url: 'https://example.com/dashboard' })
  expect(await tool.handler({ action: 'open', bookmarkId: bookmark.id }, invocation)).toMatchObject(
    { tabId: 'new' }
  )
  expect(state.open).toHaveBeenCalledWith('https://example.com/dashboard', false)
})
