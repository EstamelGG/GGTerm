import type { AiBrowserReference } from '@shared/browser'
import type { AiFileReference } from '@shared/types'
import { create } from 'zustand'

export type ActivityPanelId = 'ai' | 'performance' | 'transfers' | 'commands' | 'forwards'

interface WorkspaceState {
  browserAttachments: Record<string, AiBrowserReference[]>
  attachBrowser: (sessionId: string, reference: AiBrowserReference) => void
  removeBrowser: (sessionId: string, id: string) => void
  sidebarOpen: boolean
  activePanel: ActivityPanelId
  setSidebarOpen: (open: boolean) => void
  selectPanel: (panel: ActivityPanelId) => void
  /** 最近进入的主机会话；目录选择和显式引用均不得改变它。 */
  focusedHostId: string | null
  fileAttachments: Record<string, AiFileReference[]>
  attachFile: (sessionId: string, file: AiFileReference) => void
  removeFile: (sessionId: string, hostId: string, path: string) => void
  attachments: Record<string, string[]>
  setAiOpen: (open: boolean) => void
  focusHost: (id: string | null) => void
  attachHost: (sessionId: string, hostId: string) => void
  removeHost: (sessionId: string, hostId: string) => void
  clearAttachments: (sessionId: string) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  browserAttachments: {},
  attachBrowser: (sessionId, reference) =>
    set((s) => ({
      sidebarOpen: true,
      activePanel: 'ai',
      browserAttachments: {
        ...s.browserAttachments,
        [sessionId]: [
          ...(s.browserAttachments[sessionId] ?? []).filter(
            (item) =>
              !(
                item.tabId === reference.tabId &&
                item.kind === reference.kind &&
                item.element?.selector === reference.element?.selector
              )
          ),
          reference
        ]
      }
    })),
  removeBrowser: (sessionId, id) =>
    set((s) => ({
      browserAttachments: {
        ...s.browserAttachments,
        [sessionId]: (s.browserAttachments[sessionId] ?? []).filter((item) => item.id !== id)
      }
    })),
  sidebarOpen: false,
  activePanel: 'ai',
  focusedHostId: null,
  attachments: {},
  fileAttachments: {},
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  selectPanel: (activePanel) => set({ activePanel, sidebarOpen: true }),
  setAiOpen: (open) =>
    set(open ? { sidebarOpen: true, activePanel: 'ai' } : { sidebarOpen: false }),
  focusHost: (focusedHostId) => set({ focusedHostId }),
  attachHost: (sessionId, hostId) =>
    set((s) => ({
      sidebarOpen: true,
      activePanel: 'ai',
      attachments: {
        ...s.attachments,
        [sessionId]: [...new Set([...(s.attachments[sessionId] ?? []), hostId])]
      }
    })),
  attachFile: (sessionId, file) =>
    set((s) => ({
      sidebarOpen: true,
      activePanel: 'ai',
      fileAttachments: {
        ...s.fileAttachments,
        [sessionId]: [
          ...(s.fileAttachments[sessionId] ?? []).filter(
            (item) => item.hostId !== file.hostId || item.path !== file.path
          ),
          file
        ]
      }
    })),
  removeFile: (sessionId, hostId, path) =>
    set((s) => ({
      fileAttachments: {
        ...s.fileAttachments,
        [sessionId]: (s.fileAttachments[sessionId] ?? []).filter(
          (item) => item.hostId !== hostId || item.path !== path
        )
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
    set((s) => ({
      attachments: { ...s.attachments, [sessionId]: [] },
      fileAttachments: { ...s.fileAttachments, [sessionId]: [] },
      browserAttachments: { ...s.browserAttachments, [sessionId]: [] }
    }))
}))
