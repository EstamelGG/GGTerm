import { useEffect, useState } from 'react'
import type { SshConnectionSession } from '@shared/types'
import { errorMessage } from '@shared/error'

/** One non-overlapping snapshot request for the visible page, never one timer per row. */
export function useConnectionSessions(
  active: boolean,
  hostIds: string[]
): {
  items: SshConnectionSession[]
  loading: boolean
  error: string | null
} {
  const [state, setState] = useState<{
    items: SshConnectionSession[]
    loading: boolean
    error: string | null
  }>({ items: [], loading: true, error: null })
  const key = JSON.stringify(hostIds)
  useEffect(() => {
    if (!active) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const ids = JSON.parse(key) as string[]
    // 内容无变化不 setState：1s 轮询不能变成每秒一次的全表重渲染
    let lastSignature: string | null = null
    const refresh = async (): Promise<void> => {
      try {
        const items = ids.length ? await window.aterm.hosts.connectionSessions(ids) : []
        if (live) {
          const signature = JSON.stringify(items)
          if (signature !== lastSignature) {
            lastSignature = signature
            setState({ items, loading: false, error: null })
          }
        }
      } catch (error) {
        if (live) setState((prev) => ({ ...prev, loading: false, error: errorMessage(error) }))
      } finally {
        if (live) timer = setTimeout(() => void refresh(), 1000)
      }
    }
    void refresh()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [active, key])
  return state
}
