import type { ExecutionSnapshot } from '@shared/execution'

interface Options {
  ids: () => string[]
  load: (sessionId: string) => Promise<ExecutionSnapshot[]>
  onChanged: (callback: (sessionId: string) => void) => () => void
  onSessionsChanged: (callback: () => void) => () => void
  apply: (tasks: ExecutionSnapshot[]) => void
  failed: (id: string, error: unknown, retry: () => void) => void
  recovered: (id: string) => void
}

/** One shared, event-driven snapshot reader; periodic reconciliation handles missed events. */
export function watchExecutions(options: Options): () => void {
  const entries = new Map<
    string,
    { due: number; attempt: number; revision: number; busy: boolean }
  >()
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const request = (id: string): void => {
    const entry = entries.get(id)
    if (!active || !entry) return
    entry.revision++
    entry.due = Date.now()
    schedule()
  }
  const schedule = (): void => {
    clearTimeout(timer)
    if (!active) return
    const due = [...entries.values()].filter((entry) => !entry.busy).map((entry) => entry.due)
    if (due.length) timer = setTimeout(pump, Math.max(0, Math.min(...due) - Date.now()))
  }
  const pump = (): void => {
    for (const [id, entry] of entries) {
      if (entry.busy || entry.due > Date.now()) continue
      entry.busy = true
      const revision = entry.revision
      const current = (): boolean =>
        active && entries.get(id) === entry && revision === entry.revision
      void (async () => {
        try {
          const tasks = await options.load(id)
          if (!current()) return
          options.apply(tasks)
          options.recovered(id)
          entry.attempt = 0
          entry.due = Date.now() + 15000
        } catch (error) {
          if (!current()) return
          entry.attempt++
          entry.due = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(entry.attempt - 1, 5))
          options.failed(id, error, () => request(id))
        } finally {
          entry.busy = false
          schedule()
        }
      })()
    }
    schedule()
  }
  const reconcile = (): void => {
    const ids = new Set(options.ids().filter((id) => !id.startsWith('pending:')))
    for (const id of entries.keys()) {
      if (ids.has(id)) continue
      entries.delete(id)
      options.recovered(id)
    }
    for (const id of ids)
      if (!entries.has(id))
        entries.set(id, { due: Date.now(), attempt: 0, revision: 0, busy: false })
    schedule()
  }
  const offChanges = options.onChanged(request)
  const offSessions = options.onSessionsChanged(reconcile)
  reconcile()
  return () => {
    active = false
    clearTimeout(timer)
    offChanges()
    offSessions()
    for (const id of entries.keys()) options.recovered(id)
    entries.clear()
  }
}
