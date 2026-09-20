import { create } from 'zustand'

interface WorkspaceState {
  aiOpen: boolean
  /** 最近进入的主机会话；目录选择和显式引用均不得改变它。 */
  focusedHostId: string | null
  attachments: Record<string, string[]>
  setAiOpen: (open: boolean) => void
  focusHost: (id: string | null) => void
  attachHost: (sessionId: string, hostId: string) => void
  removeHost: (sessionId: string, hostId: string) => void
  clearAttachments: (sessionId: string) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  aiOpen: true,
  focusedHostId: null,
  attachments: {},
  setAiOpen: (aiOpen) => set({ aiOpen }),
  focusHost: (focusedHostId) => set({ focusedHostId }),
  attachHost: (sessionId, hostId) =>
    set((s) => ({
      aiOpen: true,
      attachments: {
        ...s.attachments,
        [sessionId]: [...new Set([...(s.attachments[sessionId] ?? []), hostId])]
      }
    })),
  removeHost: (sessionId, hostId) =>
    set((s) => ({
      attachments: {
        ...s.attachments,
        [sessionId]: (s.attachments[sessionId] ?? []).filter((id) => id !== hostId)
      }
    })),
  clearAttachments: (sessionId) =>
    set((s) => ({ attachments: { ...s.attachments, [sessionId]: [] } }))
}))
