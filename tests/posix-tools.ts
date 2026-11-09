import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Run the actual remote POSIX scripts on Windows using Git for Windows, not WSL. */
export function posixTool(name: 'sh' | 'awk' | 'cygpath'): string {
  if (process.platform !== 'win32') return name === 'sh' ? '/bin/sh' : name
  const directory =
    process.env.GGTERM_POSIX_BIN ||
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin')
  const executable = join(directory, `${name}.exe`)
  if (!existsSync(executable))
    throw new Error(`Install Git for Windows or set GGTERM_POSIX_BIN: ${executable}`)
  return executable
}

export function posixTestPath(path: string): string {
  return process.platform === 'win32'
    ? path
        .replaceAll('\\', '/')
        .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    : path
}
