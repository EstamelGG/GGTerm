import { create } from 'zustand'
import type { ExecutionSnapshot } from '@shared/execution'
import { useSessionStore } from './session'
import { useConnectionsStore } from './connections'

interface State {
  tasks: ExecutionSnapshot[]
  dismissed: string[]
  sync: (tasks: ExecutionSnapshot[], reveal?: boolean) => void
  close: (task: ExecutionSnapshot) => Promise<void>
}
export const useExecutionTabs = create<State>((set, get) => ({
  tasks: [],
  dismissed: [],
  sync: (tasks, reveal = false) => {
    const known = new Set(get().tasks.map((t) => t.executionId))
    const incoming = tasks.filter(
      (task) =>
        reveal ||
        (!get().dismissed.includes(task.executionId) &&
          (known.has(task.executionId) || task.status === 'running' || task.status === 'starting'))
    )
    set((s) => ({
      tasks: [
        ...s.tasks.filter((old) => !incoming.some((task) => task.executionId === old.executionId)),
        ...incoming
      ],
      dismissed: reveal
        ? s.dismissed.filter((id) => !incoming.some((task) => task.executionId === id))
        : s.dismissed
    }))
    for (const task of incoming) {
      const store = useSessionStore.getState()
      const conn = useConnectionsStore.getState().connections.find((c) => c.id === task.hostId)
      if (!conn) continue
      if (!reveal && known.has(task.executionId) && !store.hosts.some((h) => h.id === task.hostId))
        continue
      if (!store.hosts.some((host) => host.id === task.hostId)) {
        // Viewer-only workspace: never create a user SSH transport just to watch an agent.
        useSessionStore.setState((s) => ({
          hosts: [
            ...s.hosts,
            {
              viewerOnly: true,
              id: conn.id,
              conn,
              title: conn.name,
              phase: 'idle',
              attempt: 0,
              offlineReason: '',
              awaiting: false,
              pendingSecrets: null,
              shells: [],
              files: [],
              focusFileId: null,
              focusShellId: task.executionId
            }
          ]
        }))
      }
      if (reveal) {
        store.focusShell(task.hostId, task.executionId)
        store.setTab({ kind: 'host', id: task.hostId })
      }
    }
  },
  close: async (task) => {
    await window.aterm.executions.terminate(task.sessionId, task.executionId)
    set((s) => ({
      tasks: s.tasks.filter((t) => t.executionId !== task.executionId),
      dismissed: [...s.dismissed, task.executionId]
    }))
    const host = useSessionStore.getState().hosts.find((h) => h.id === task.hostId)
    if (host?.focusShellId === task.executionId)
      useSessionStore
        .getState()
        .focusShell(
          task.hostId,
          host.shells[0]?.id ?? get().tasks.find((t) => t.hostId === task.hostId)?.executionId ?? ''
        )
  }
}))
export async function openExecutionTabs(sessionId: string, hostId?: string): Promise<void> {
  const tasks = await window.aterm.executions.list(sessionId, hostId)
  useExecutionTabs.getState().sync(tasks, true)
}
