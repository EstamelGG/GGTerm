import { create } from 'zustand'
import { useWorkspaceIssues } from './workspaceIssues'
import type { HostStateEvent } from '@shared/types'
import {
  connectionSlot,
  type ConnectionState,
  type ConnectionStateEvent
} from '@shared/connectionState'

interface LinksState {
  byHost: Record<string, HostStateEvent>
  userByHost: Record<string, ConnectionState>
  connections: ConnectionState[]
  watch: () => () => void
}

const rank = { connected: 0, connecting: 1, reconnecting: 2, offline: 3, idle: 4 }
let watching: { users: number; stop: () => void } | undefined

/** One subscription and one ordered snapshot for every connection owner. */
export const useLinksStore = create<LinksState>((set) => ({
  byHost: {},
  userByHost: {},
  connections: [],
  watch: () => {
    if (!watching) {
      let active = true
      let request = 0
      let floor = 0
      let pending: ConnectionStateEvent[] | undefined = []
      const slots = new Map<string, ConnectionState>()
      const versions = new Map<string, number>()
      const apply = (event: ConnectionStateEvent): void => {
        const slot = connectionSlot(event.state)
        if (event.state.revision <= Math.max(floor, versions.get(slot) ?? 0)) return
        versions.set(slot, event.state.revision)
        if (event.removed) slots.delete(slot)
        else slots.set(slot, event.state)
      }
      const publish = (): void => {
        const byHost: LinksState['byHost'] = {}
        const userByHost: LinksState['userByHost'] = {}
        const connections = [...slots.values()]
        for (const state of connections) {
          if (state.owner === 'user') userByHost[state.hostId] = state
          const current = byHost[state.hostId]
          if (
            !current ||
            rank[state.phase] < rank[current.phase] ||
            (state.phase === current.phase && state.since > current.since)
          )
            byHost[state.hostId] = state
        }
        set({ byHost, userByHost, connections })
      }
      const off = window.aterm.hosts.onConnectionState((event) => {
        if (!active) return
        pending?.push(event)
        apply(event)
        publish()
      })
      const restore = (): Promise<void> => {
        if (!active) return Promise.resolve()
        const version = ++request
        pending = []
        return window.aterm.hosts
          .runtimeSnapshot()
          .then((snapshot) => {
            if (!active || version !== request) return
            slots.clear()
            versions.clear()
            for (const state of snapshot.connections) {
              slots.set(connectionSlot(state), state)
              versions.set(connectionSlot(state), state.revision)
            }
            floor = snapshot.revision
            for (const event of pending ?? []) apply(event)
            pending = undefined
            publish()
            useWorkspaceIssues.getState().clear('connections')
          })
          .catch((error) => {
            if (!active || version !== request) return
            // Live events still recover the mirror if the initial snapshot fails.
            pending = undefined
            useWorkspaceIssues.getState().report('connections', error, 'recovery', restore)
          })
      }
      void restore()
      watching = {
        users: 0,
        stop: () => {
          active = false
          off()
        }
      }
    }
    const subscription = watching
    subscription.users++
    let released = false
    return () => {
      if (released) return
      released = true
      if (--subscription.users === 0) {
        subscription.stop()
        watching = undefined
      }
    }
  }
}))
