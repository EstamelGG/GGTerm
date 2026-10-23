import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { posix, win32 } from 'node:path'
import type { LocalShells } from '../shared/localTerminal'

/** Inspect files only; discovering a shell never runs it or its startup scripts. */
export async function listLocalShells(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): Promise<LocalShells> {
  const windows = platform === 'win32'
  const path = windows ? win32 : posix
  let systemDefault = ''
  let candidates: string[]
  if (windows) {
    const root = env.SystemRoot || 'C:\\Windows'
    const powershell = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    candidates = [
      env.ComSpec || path.join(root, 'System32', 'cmd.exe'),
      powershell,
      path.join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
    ]
    for (const dir of (env.Path || env.PATH || '').split(';').filter(Boolean)) {
      for (const file of ['cmd.exe', 'powershell.exe', 'pwsh.exe'])
        candidates.push(path.join(dir.replace(/^"|"$/g, ''), file))
    }
    systemDefault = powershell
  } else {
    systemDefault = env.SHELL || userInfo().shell || '/bin/sh'
    let configured: string[] = []
    try {
      configured = (await readFile('/etc/shells', 'utf8'))
        .split(/\r?\n/)
        .map((line) => line.split('#')[0].trim())
        .filter((line) => line.startsWith('/'))
    } catch {
      /* Standard locations still work without /etc/shells. */
    }
    candidates = [
      systemDefault,
      ...configured,
      '/bin/sh',
      '/bin/bash',
      '/bin/zsh',
      '/usr/bin/sh',
      '/usr/bin/bash',
      '/usr/bin/zsh',
      '/usr/bin/fish',
      '/usr/local/bin/bash',
      '/usr/local/bin/zsh',
      '/usr/local/bin/fish',
      '/opt/homebrew/bin/bash',
      '/opt/homebrew/bin/zsh',
      '/opt/homebrew/bin/fish'
    ]
  }
  const unique = new Map<string, string>()
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue
    const normalized = path.normalize(candidate)
    const key = windows ? normalized.toLowerCase() : normalized
    if (!unique.has(key)) unique.set(key, normalized)
  }
  const available = await Promise.all(
    [...unique.values()].map(async (candidate) => {
      try {
        if (!(await stat(candidate)).isFile()) return null
        await access(candidate, windows ? constants.F_OK : constants.X_OK)
        const file = path.basename(candidate)
        const label = /^powershell\.exe$/i.test(file)
          ? 'Windows PowerShell'
          : /^pwsh\.exe$/i.test(file)
            ? 'PowerShell 7'
            : /^cmd\.exe$/i.test(file)
              ? 'Command Prompt (cmd)'
              : file
        return { path: candidate, label }
      } catch {
        return null
      }
    })
  )
  const shells = available.filter((shell) => shell !== null)
  const preferred = shells.find((shell) =>
    windows
      ? shell.path.toLowerCase() === systemDefault.toLowerCase()
      : shell.path === systemDefault
  )
  return { shells, defaultPath: preferred?.path || shells[0]?.path || '' }
}

export async function localShellInvocation(
  preferred = ''
): Promise<{ shell: string; args: string[]; cwd: string }> {
  const { shells, defaultPath } = await listLocalShells()
  const shell = preferred || defaultPath
  const found = shells.find((item) =>
    process.platform === 'win32'
      ? item.path.toLowerCase() === shell.toLowerCase()
      : item.path === shell
  )
  if (!found)
    throw new Error(
      preferred
        ? `Local shell is unavailable: ${preferred}. Choose another shell in Settings.`
        : 'No local shell is available'
    )
  return {
    shell: found.path,
    args: process.platform !== 'win32' ? ['-l'] : /cmd\.exe$/i.test(found.path) ? [] : ['-NoLogo'],
    cwd: homedir()
  }
}
