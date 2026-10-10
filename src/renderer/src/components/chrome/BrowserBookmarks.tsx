import { useEffect, useEffectEvent, useState } from 'react'
import { Bookmark, Star, Pencil, Trash2, Plus, Globe, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BrowserTab } from '@shared/browser'
import type { BrowserBookmark } from '@shared/browserBookmarks'
import { IconButton } from '@/components/ui/IconButton'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ATTextField } from '@/components/form/Fields'
import { ATField, Button } from '@/components/form/Buttons'
import { errorMessage } from '@shared/error'

export function BrowserBookmarks({
  current,
  onOpen,
  onError
}: {
  current?: BrowserTab
  onOpen: (url: string) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [items, setItems] = useState<BrowserBookmark[]>([])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<{ id?: string; title: string; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const report = useEffectEvent((value: unknown) => onError(errorMessage(value)))
  useEffect(() => {
    let live = true,
      revision = 0
    const off = window.aterm.browser.bookmarks.onChanged((next) => {
      revision++
      setItems(next)
    })
    void window.aterm.browser.bookmarks
      .list()
      .then((next) => {
        if (live && revision === 0) setItems(next)
      })
      .catch(report)
    return () => {
      live = false
      off()
    }
  }, [])
  const saved = items.find((item) => item.url === current?.url)
  const save = async (input: { id?: string; title: string; url: string }): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (input.id)
        await window.aterm.browser.bookmarks.update(input.id, {
          title: input.title,
          url: input.url
        })
      else await window.aterm.browser.bookmarks.save({ title: input.title, url: input.url })
      setDraft(null)
    } catch (value) {
      setError(errorMessage(value))
      setOpen(true)
    } finally {
      setBusy(false)
    }
  }
  const visible = items.filter((item) =>
    `${item.title}\n${item.url}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  )
  return (
    <>
      <IconButton
        icon={Star}
        title={t(saved ? 'browser.editBookmark' : 'browser.saveBookmark')}
        selected={!!saved}
        className={saved ? 'text-warn hover:text-warn [&_svg]:fill-current' : undefined}
        aria-pressed={!!saved}
        disabled={
          !current ||
          !/^https?:\/\//i.test(current.url) ||
          current.loading ||
          current.controlling ||
          busy
        }
        onClick={() => {
          if (saved) {
            setDraft(saved)
            setError(null)
            setOpen(true)
          } else if (current) void save({ title: current.title.slice(0, 200), url: current.url })
        }}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <IconButton icon={Bookmark} title={t('browser.bookmarks')} selected={open} />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)]">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-title font-semibold">{t('browser.bookmarks')}</h2>
            <IconButton
              icon={Plus}
              title={t('browser.newBookmark')}
              disabled={busy}
              onClick={() => {
                setDraft({ title: '', url: '' })
                setError(null)
              }}
            />
          </div>
          {draft ? (
            <div className="space-y-3">
              <ATField title={t('browser.bookmarkTitle')}>
                <ATTextField
                  value={draft.title}
                  autoFocus
                  disabled={busy}
                  onChange={(title) => setDraft({ ...draft, title })}
                />
              </ATField>
              <ATField title={t('browser.address')}>
                <ATTextField
                  value={draft.url}
                  className="font-mono"
                  placeholder="https://"
                  disabled={busy}
                  onChange={(url) => setDraft({ ...draft, url })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && draft.title.trim() && draft.url.trim())
                      void save(draft)
                  }}
                />
              </ATField>
              <div className="flex justify-end gap-2">
                <Button
                  title={t('common.cancel')}
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null)
                    setError(null)
                  }}
                />
                <Button
                  title={t('common.save')}
                  disabled={busy || !draft.title.trim() || !draft.url.trim()}
                  onClick={() => {
                    void save(draft)
                  }}
                />
              </div>
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center gap-2">
                <Search size={14} className="shrink-0 text-muted" />
                <ATTextField
                  value={query}
                  onChange={setQuery}
                  placeholder={t('browser.searchBookmarks')}
                />
              </div>
              <div className="max-h-80 overflow-y-auto">
                {visible.length === 0 && (
                  <p className="py-6 text-center text-body text-muted">
                    {t(items.length ? 'browser.noBookmarksMatch' : 'browser.noBookmarks')}
                  </p>
                )}
                {visible.map((item) => (
                  <div key={item.id} className="flex items-center gap-1 rounded-lg hover:bg-hover">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg p-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-at-accent"
                      title={item.url}
                      onClick={() => {
                        setOpen(false)
                        onOpen(item.url)
                      }}
                    >
                      <Globe size={14} className="shrink-0 text-muted" />
                      <span className="min-w-0">
                        <span className="block truncate text-body text-fg">{item.title}</span>
                        <span className="block truncate font-mono text-caption text-muted">
                          {item.url}
                        </span>
                      </span>
                    </button>
                    <IconButton
                      icon={Pencil}
                      title={t('browser.editBookmark')}
                      disabled={busy}
                      onClick={() => {
                        setDraft(item)
                        setError(null)
                      }}
                    />
                    <IconButton
                      icon={Trash2}
                      title={t('browser.deleteBookmark')}
                      disabled={busy}
                      onClick={() => {
                        setBusy(true)
                        setError(null)
                        void window.aterm.browser.bookmarks
                          .delete(item.id)
                          .catch((value) => setError(errorMessage(value)))
                          .finally(() => setBusy(false))
                      }}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="mt-3 select-text break-words text-minor text-danger">
              {error}
            </p>
          )}
        </PopoverContent>
      </Popover>
    </>
  )
}
