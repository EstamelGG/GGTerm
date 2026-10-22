import { create } from 'zustand'
import type { LocalTerminalSession } from '@shared/localTerminal'
import { localTerminalKey } from '@shared/localTerminal'
import { errorMessage } from '@shared/error'

export interface LocalTerminalTab extends LocalTerminalSession {
  number: number
  exitCode?: number
  error?: string
}

interface LocalTerminalStore {
  tabs: LocalTerminalTab[]
  activeId: string | null
  creating: boolean
  create: () => Promise<void>
  close: (id: string) => Promise<void>
  select: (id: string) => void
}

let nextNumber = 1
let watching = false
export const useLocalTerminalStore = create<LocalTerminalStore>((set, get) => ({
  tabs: [],
  activeId: null,
  creating: false,
  select: (activeId) => set({ activeId }),
  create: async () => {
    if (get().creating) return
    set({ creating: true })
    let id: string | undefined
    try {
      const registry = await import('@/terminal/registry')
      if (!watching) {
        window.aterm.localTerminal.onEvent((event) => {
          const key = localTerminalKey(event.id)
          if (event.type === 'data') registry.writeTerminal(key, event.data)
          else {
            set((s) => ({
              tabs: s.tabs.map((tab) =>
                tab.id === event.id ? { ...tab, exitCode: event.exitCode } : tab
              )
            }))
            registry.writeTerminal(key, `\r\n[${event.exitCode}]\r\n`)
          }
        })
        watching = true
      }
      const session = await window.aterm.localTerminal.create()
      id = session.id
      const key = localTerminalKey(id)
      const report = (error: unknown): void => {
        set((s) => ({
          tabs: s.tabs.map((tab) =>
            tab.id === session.id ? { ...tab, error: errorMessage(error) } : tab
          )
        }))
      }
      registry.createTerminal(key, {
        onData: (data) => {
          void window.aterm.localTerminal.write(session.id, data).catch(report)
        },
        onResize: (cols, rows) => {
          void window.aterm.localTerminal.resize(session.id, cols, rows).catch(report)
        }
      })
      set((s) => ({
        tabs: [...s.tabs, { ...session, number: nextNumber++ }],
        activeId: session.id
      }))
      await window.aterm.localTerminal.ready(session.id)
    } catch (error) {
      if (id) {
        await window.aterm.localTerminal.close(id).catch(() => {})
        const registry = await import('@/terminal/registry')
        registry.disposeTerminal(localTerminalKey(id))
        set((s) => ({
          tabs: s.tabs.filter((tab) => tab.id !== id),
          activeId: s.tabs.find((tab) => tab.id !== id)?.id ?? null
        }))
      }
      throw error
    } finally {
      set({ creating: false })
    }
  },
  close: async (id) => {
    await window.aterm.localTerminal.close(id)
    const registry = await import('@/terminal/registry')
    registry.disposeTerminal(localTerminalKey(id))
    set((s) => {
      const index = s.tabs.findIndex((tab) => tab.id === id)
      const tabs = s.tabs.filter((tab) => tab.id !== id)
      return {
        tabs,
        activeId:
          s.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : s.activeId
      }
    })
  }
}))
