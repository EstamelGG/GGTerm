import { create } from 'zustand'

/**
 * 快捷指令（活动栏）：localStorage 持久化的轻量命令库。
 * 渲染层自治（无 IPC/主进程参与）：数据量小、结构稳定，本地存储最简且零同步成本。
 */

export interface QuickCommand {
  id: string
  name: string
  command: string
}

const KEY = 'ggterm.quickCommands'

function load(): QuickCommand[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter(
      (c): c is QuickCommand =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as QuickCommand).id === 'string' &&
        typeof (c as QuickCommand).name === 'string' &&
        typeof (c as QuickCommand).command === 'string'
    )
  } catch {
    return []
  }
}

const persist = (commands: QuickCommand[]): void => {
  localStorage.setItem(KEY, JSON.stringify(commands))
}

interface CommandsState {
  commands: QuickCommand[]
  add: (name: string, command: string) => void
  update: (id: string, name: string, command: string) => void
  remove: (id: string) => void
}

export const useCommandsStore = create<CommandsState>((set) => ({
  commands: load(),
  add: (name, command) =>
    set((s) => {
      const commands = [{ id: crypto.randomUUID(), name: name.trim(), command }, ...s.commands]
      persist(commands)
      return { commands }
    }),
  update: (id, name, command) =>
    set((s) => {
      const commands = s.commands.map((c) =>
        c.id === id ? { ...c, name: name.trim(), command } : c
      )
      persist(commands)
      return { commands }
    }),
  remove: (id) =>
    set((s) => {
      const commands = s.commands.filter((c) => c.id !== id)
      persist(commands)
      return { commands }
    })
}))
