import { useLocalTerminalStore } from '@/stores/localTerminal'
import { usePortForwardsStore } from '@/stores/portForwards'
import { usePrefsStore } from '@/stores/prefs'
import { useSessionStore } from '@/stores/session'
import { useCallback, useEffect, useState } from 'react'

interface PendingClose {
  ids: string[]
  quit: boolean
}
export function useWorkspaceClose(): {
  pendingClose: PendingClose | null
  setPendingClose: React.Dispatch<React.SetStateAction<PendingClose | null>>
  affectedForwardCount: number
  requestClose: (ids: string[], quit?: boolean) => void
} {
  const closeHost = useSessionStore((s) => s.closeHost)
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  const affectedForwardCount = usePortForwardsStore((s) =>
    pendingClose
      ? s.rules.filter(
          (rule) =>
            !['stopped', 'error'].includes(rule.status) &&
            (pendingClose.quit || (rule.owner === 'user' && pendingClose.ids.includes(rule.hostId)))
        ).length
      : 0
  )
  const prefs = usePrefsStore((s) => s.data)

  const requestClose = useCallback(
    (ids: string[], quit = false): void => {
      const state = useSessionStore.getState()
      const targets = state.hosts.filter((h) => ids.includes(h.id))
      const protectedFiles = targets.some((h) =>
        h.files.some((f) => f.text !== f.saved || f.saving)
      )
      const localRunning =
        quit && useLocalTerminalStore.getState().tabs.some((tab) => tab.exitCode === undefined)
      const confirmSession =
        (targets.length > 0 || localRunning) && (!quit || (prefs?.confirmCloseSession ?? true))
      if (protectedFiles || confirmSession) setPendingClose({ ids, quit })
      else if (quit) window.aterm.window.confirmClose()
      else ids.forEach((id) => closeHost(id))
    },
    [closeHost, prefs?.confirmCloseSession]
  )

  useEffect(
    () =>
      window.aterm.window.onCloseRequest(() =>
        requestClose(
          useSessionStore.getState().hosts.map((h) => h.id),
          true
        )
      ),
    [requestClose]
  )

  useEffect(() => {
    const preventReload = (event: BeforeUnloadEvent): void => {
      if (
        useSessionStore
          .getState()
          .hosts.some((h) => h.files.some((f) => f.text !== f.saved || f.saving))
      ) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', preventReload)
    return () => window.removeEventListener('beforeunload', preventReload)
  }, [])

  return { pendingClose, setPendingClose, affectedForwardCount, requestClose }
}
