export interface LocalTerminalSession {
  id: string
  shell: string
  cwd: string
}

export type LocalTerminalEvent =
  { type: 'data'; id: string; data: string } | { type: 'exit'; id: string; exitCode: number }

export const localTerminalKey = (id: string): string => `local:${id}`

export interface LocalShellOption {
  path: string
  label: string
}

export interface LocalShells {
  shells: LocalShellOption[]
  defaultPath: string
}
