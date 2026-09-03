import { create } from 'zustand'
import type { ConnectionSecrets, HostConnection, HostGroup, ServerNote } from '@shared/types'

interface ConnectionsState {
  connections: HostConnection[]
  groups: HostGroup[]
  loaded: boolean
  load: () => Promise<void>
  create: (
    input: Partial<HostConnection> & Pick<HostConnection, 'name' | 'host' | 'username'>,
    secrets: Partial<ConnectionSecrets>
  ) => Promise<HostConnection>
  update: (
    id: string,
    patch: Partial<HostConnection>,
    secrets?: Partial<ConnectionSecrets>
  ) => Promise<HostConnection | null>
  setNote: (id: string, note: ServerNote) => Promise<HostConnection | null>
  remove: (id: string) => Promise<boolean>
  createGroup: (input: Partial<HostGroup> & Pick<HostGroup, 'name'>) => Promise<HostGroup>
  updateGroup: (id: string, patch: Partial<HostGroup>) => Promise<HostGroup | null>
  removeGroup: (id: string) => Promise<{ removed: string[]; ungrouped: number } | null>
}

export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
  connections: [],
  groups: [],
  loaded: false,

  load: async () => {
    const [connections, groups] = await Promise.all([
      window.aterm.connections.list(),
      window.aterm.groups.list()
    ])
    set({ connections, groups, loaded: true })
  },

  create: async (input, secrets) => {
    const conn = await window.aterm.connections.create(input)
    try {
      await window.aterm.secrets.save(conn.id, secrets)
    } catch (err) {
      await window.aterm.connections.remove(conn.id)
      throw err
    }
    set((s) => ({
      connections: s.connections.some((c) => c.id === conn.id)
        ? s.connections.map((c) => (c.id === conn.id ? conn : c))
        : [...s.connections, conn]
    }))
    return conn
  },

  update: async (id, patch, secrets) => {
    const previous = get().connections.find((connection) => connection.id === id)
    const conn = await window.aterm.connections.update(id, patch)
    if (!conn) return null
    try {
      if (secrets) await window.aterm.secrets.save(id, secrets)
    } catch (err) {
      if (previous) await window.aterm.connections.update(id, previous)
      throw err
    }
    set((s) => ({ connections: s.connections.map((c) => (c.id === id ? conn : c)) }))
    return conn
  },

  setNote: async (id, note) => {
    const conn = await window.aterm.connections.setNote(id, note)
    if (conn) set((s) => ({ connections: s.connections.map((c) => (c.id === id ? conn : c)) }))
    return conn
  },

  remove: async (id) => {
    const ok = await window.aterm.connections.remove(id) // 主进程顺带清凭据
    if (ok) set((s) => ({ connections: s.connections.filter((c) => c.id !== id) }))
    return ok
  },

  createGroup: async (input) => {
    const group = await window.aterm.groups.create(input)
    set((s) => ({
      groups: s.groups.some((g) => g.id === group.id)
        ? s.groups.map((g) => (g.id === group.id ? group : g))
        : [...s.groups, group]
    }))
    return group
  },

  updateGroup: async (id, patch) => {
    const group = await window.aterm.groups.update(id, patch)
    if (group) set((s) => ({ groups: s.groups.map((g) => (g.id === id ? group : g)) }))
    return group
  },

  removeGroup: async (id) => {
    const result = await window.aterm.groups.remove(id)
    if (result) {
      const removed = new Set(result.removed)
      set((s) => ({
        groups: s.groups.filter((g) => !removed.has(g.id)),
        connections: s.connections.map((c) =>
          c.groupId && removed.has(c.groupId) ? { ...c, groupId: null } : c
        )
      }))
    }
    return result
  }
}))
