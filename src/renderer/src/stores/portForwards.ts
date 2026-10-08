import { create } from 'zustand'
import type { PortForward } from '@shared/portForward'
import { useWorkspaceStore } from './workspace'

interface ForwardState {
  rules: PortForward[]
  filterHostId: string
  editor: { hostId: string; rule?: PortForward } | null
  setRules: (rules: PortForward[]) => void
  setFilter: (hostId: string) => void
  edit: (rule: PortForward) => void
  closeEditor: () => void
  open: (hostId?: string, create?: boolean) => void
}

export const usePortForwardsStore = create<ForwardState>((set) => ({
  rules: [],
  filterHostId: '',
  editor: null,
  setRules: (rules) => set({ rules }),
  setFilter: (filterHostId) => set({ filterHostId }),
  edit: (rule) => set({ editor: { hostId: rule.hostId, rule } }),
  closeEditor: () => set({ editor: null }),
  open: (hostId = '', create = false) => {
    set({ filterHostId: hostId, editor: create ? { hostId } : null })
    useWorkspaceStore.getState().selectPanel('forwards')
  }
}))
