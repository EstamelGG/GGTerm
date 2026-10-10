import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { z } from 'zod'
import type { BrowserBookmark, BrowserBookmarkInput } from '../../shared/browserBookmarks'

const store = new Store<{ bookmarks: BrowserBookmark[] }>({
  name: 'browser-bookmarks',
  defaults: { bookmarks: [] }
})
const events = new EventEmitter()
const titleSchema = z.string().trim().min(1).max(200)
const urlSchema = z
  .string()
  .trim()
  .max(8000)
  .transform((value, ctx) => {
    try {
      const url = new URL(value)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
    } catch {
      /* Invalid URL is reported below. */
    }
    ctx.addIssue({ code: 'custom', message: 'Bookmarks require a valid HTTP or HTTPS URL' })
    return z.NEVER
  })
const inputSchema = z.object({ title: titleSchema.optional(), url: urlSchema })
export function listBrowserBookmarks(query = ''): BrowserBookmark[] {
  const text = query.trim().toLocaleLowerCase()
  return store
    .get('bookmarks')
    .filter((item) => !text || `${item.title}\n${item.url}`.toLocaleLowerCase().includes(text))
}
export function getBrowserBookmark(id: string): BrowserBookmark {
  const item = listBrowserBookmarks().find((item) => item.id === id)
  if (!item) throw new Error(`Bookmark not found: ${id}`)
  return item
}
function write(bookmarks: BrowserBookmark[]): void {
  store.set('bookmarks', bookmarks)
  events.emit('changed', bookmarks)
}
export function onBrowserBookmarksChanged(
  listener: (items: BrowserBookmark[]) => void
): () => void {
  events.on('changed', listener)
  return () => {
    events.off('changed', listener)
  }
}
export function saveBrowserBookmark(input: BrowserBookmarkInput): BrowserBookmark {
  const parsed = inputSchema.parse(input)
  const items = listBrowserBookmarks()
  const existing = items.find((item) => item.url === parsed.url)
  if (existing) return updateBrowserBookmark(existing.id, { title: parsed.title ?? existing.title })
  if (items.length >= 500) throw new Error('Bookmark limit reached (500)')
  const now = Date.now()
  const item = {
    id: randomUUID(),
    title: parsed.title ?? new URL(parsed.url).hostname,
    url: parsed.url,
    createdAt: now,
    updatedAt: now
  }
  write([...items, item])
  return item
}
export function updateBrowserBookmark(
  id: string,
  patch: Partial<BrowserBookmarkInput>
): BrowserBookmark {
  const parsed = inputSchema
    .partial()
    .refine(
      (value) => value.title !== undefined || value.url !== undefined,
      'Provide a title or URL to update'
    )
    .parse(patch)
  const existing = getBrowserBookmark(id)
  const items = listBrowserBookmarks()
  if (parsed.url && items.some((item) => item.id !== id && item.url === parsed.url))
    throw new Error('This URL is already bookmarked')
  const item = {
    ...existing,
    title: parsed.title ?? existing.title,
    url: parsed.url ?? existing.url,
    updatedAt: Date.now()
  }
  write(items.map((entry) => (entry.id === id ? item : entry)))
  return item
}
export function deleteBrowserBookmark(id: string): void {
  getBrowserBookmark(id)
  write(listBrowserBookmarks().filter((item) => item.id !== id))
}
