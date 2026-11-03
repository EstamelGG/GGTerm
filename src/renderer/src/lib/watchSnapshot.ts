/** Subscribe first, then restore. Live changes always win over a late snapshot. */
export function watchSnapshot<T>(options: {
  load: () => Promise<T[]>
  listen: (upsert: (item: T) => void, remove: (id: string) => void) => () => void
  key: (item: T) => string
  replace: (items: T[]) => void
  upsert: (item: T) => void
  remove: (id: string) => void
  failed: (error: unknown, retry: () => Promise<void>) => void
  restored: () => void
}): () => void {
  let active = true
  let revision = 0
  let changes: Map<string, T | null> | undefined
  const restore = async (): Promise<void> => {
    if (!active) return
    const version = ++revision
    const pending = new Map<string, T | null>()
    changes = pending
    try {
      const items = await options.load()
      if (!active || version !== revision) return
      const merged = new Map(items.map((item) => [options.key(item), item]))
      for (const [id, item] of pending) {
        if (item === null) merged.delete(id)
        else merged.set(id, item)
      }
      options.replace([...merged.values()])
      options.restored()
    } catch (error) {
      if (active && version === revision) options.failed(error, restore)
    } finally {
      if (changes === pending) changes = undefined
    }
  }
  const off = options.listen(
    (item) => {
      if (!active) return
      changes?.set(options.key(item), item)
      options.upsert(item)
    },
    (id) => {
      if (!active) return
      changes?.set(id, null)
      options.remove(id)
    }
  )
  void restore()
  return () => {
    active = false
    changes = undefined
    off()
  }
}
