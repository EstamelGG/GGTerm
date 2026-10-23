import { beforeEach, expect, it, vi } from 'vitest'

const files = vi.hoisted(() => new Map<string, { executable?: boolean; directory?: boolean }>())
vi.mock('node:fs/promises', () => ({
  readFile: async () => '# Available shells\n/bin/sh\n/bin/zsh # default\n/bin/sh\n/missing\n',
  stat: async (path: string) => {
    const file = files.get(path)
    if (!file) throw new Error('ENOENT')
    return { isFile: () => !file.directory }
  },
  access: async (path: string, mode: number) => {
    const file = files.get(path)
    if (!file || (mode !== 0 && !file.executable)) throw new Error('EACCES')
  }
}))
vi.mock('node:os', () => ({ homedir: () => '/home/test', userInfo: () => ({ shell: '/bin/zsh' }) }))
import { listLocalShells, localShellInvocation } from '../src/main/localShells'

beforeEach(() => {
  files.clear()
})

it('discovers executable POSIX shells, parses comments and deduplicates candidates', async () => {
  files.set('/bin/sh', { executable: true })
  files.set('/bin/zsh', { executable: true })
  files.set('/bin/bash', { executable: false })
  files.set('/usr/bin/fish', { executable: true, directory: true })
  const result = await listLocalShells('darwin', { SHELL: '/bin/zsh' })
  expect(result).toEqual({
    shells: [
      { path: '/bin/zsh', label: 'zsh' },
      { path: '/bin/sh', label: 'sh' }
    ],
    defaultPath: '/bin/zsh'
  })
})

it('discovers Windows cmd and both PowerShell versions from system locations and PATH', async () => {
  files.set('C:\\Windows\\System32\\cmd.exe', {})
  files.set('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', {})
  files.set('D:\\Tools\\pwsh.exe', {})
  const result = await listLocalShells('win32', {
    SystemRoot: 'C:\\Windows',
    Path: 'D:\\Tools;C:\\Windows\\System32'
  })
  expect(result.shells.map((shell) => shell.label)).toEqual([
    'Command Prompt (cmd)',
    'Windows PowerShell',
    'PowerShell 7'
  ])
  expect(result.defaultPath).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
})

it('uses the saved interpreter for new sessions and fails clearly if it was removed', async () => {
  files.set('/bin/sh', { executable: true })
  files.set('/bin/zsh', { executable: true })
  await expect(localShellInvocation('/bin/sh')).resolves.toEqual({
    shell: '/bin/sh',
    args: ['-l'],
    cwd: '/home/test'
  })
  await expect(localShellInvocation('/bin/missing')).rejects.toThrow(
    'Choose another shell in Settings'
  )
})
