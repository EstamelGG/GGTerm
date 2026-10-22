import { ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { homedir, userInfo } from 'node:os'
import { basename, join } from 'node:path'
import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import type { LocalTerminalEvent, LocalTerminalSession } from '../shared/localTerminal'

interface Session {
  owner: WebContents
  process: pty.IPty
  ready: boolean
  pending: string
  exitCode?: number
}

const sessions = new Map<string, Session>()
const owners = new Set<WebContents>()

export function installLocalTerminals(owner: WebContents): void {
  owners.add(owner)
  owner.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) disposeLocalTerminals(owner)
  })
  owner.once('destroyed', () => {
    owners.delete(owner)
    disposeLocalTerminals(owner)
  })
}

function owned(owner: WebContents, id: string): Session {
  const session = sessions.get(id)
  if (!session || session.owner !== owner) throw new Error('Local terminal not found')
  return session
}

function send(owner: WebContents, event: LocalTerminalEvent): void {
  if (!owner.isDestroyed()) owner.send('local-terminal:event', event)
}

function close(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
  if (session.exitCode === undefined) session.process.kill()
}

export function disposeLocalTerminals(owner?: WebContents): void {
  for (const [id, session] of sessions) {
    if (!owner || session.owner === owner) close(id)
  }
}

function shellInvocation(): { shell: string; args: string[] } {
  if (process.platform !== 'win32') {
    const shell = process.env.SHELL || userInfo().shell || '/bin/sh'
    return { shell, args: ['-l'] }
  }
  const root = process.env.SystemRoot || 'C:\\Windows'
  const shell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(shell)) return { shell, args: ['-NoLogo'] }
  return { shell: process.env.ComSpec || 'cmd.exe', args: [] }
}

export function registerLocalTerminalIpc(): void {
  ipcMain.handle('local-terminal:create', (event): LocalTerminalSession => {
    const owner = event.sender
    if (!owners.has(owner) || event.senderFrame !== owner.mainFrame)
      throw new Error('Local terminal is only available in the application')
    if ([...sessions.values()].filter((s) => s.owner === owner).length >= 20)
      throw new Error('Too many local terminals (maximum 20)')
    const { shell, args } = shellInvocation()
    const id = randomUUID()
    const cwd = homedir()
    const child = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    })
    const session: Session = { owner, process: child, ready: false, pending: '' }
    sessions.set(id, session)
    child.onData((data) => {
      if (!sessions.has(id)) return
      if (session.ready) send(owner, { type: 'data', id, data })
      else {
        session.pending += data
        if (session.pending.length >= 1024 * 1024) child.pause()
      }
    })
    child.onExit(({ exitCode }) => {
      session.exitCode = exitCode
      if (sessions.has(id) && session.ready) send(owner, { type: 'exit', id, exitCode })
    })
    return { id, cwd, shell: basename(shell) }
  })
  // Subscribe and create xterm before flushing startup output (including fast shell exits).
  ipcMain.handle('local-terminal:ready', (event, id: string) => {
    const session = owned(event.sender, id)
    if (session.ready) return
    session.ready = true
    if (session.pending) send(session.owner, { type: 'data', id, data: session.pending })
    session.pending = ''
    if (session.exitCode === undefined) session.process.resume()
    if (session.exitCode !== undefined)
      send(session.owner, { type: 'exit', id, exitCode: session.exitCode })
  })
  ipcMain.handle('local-terminal:write', (event, id: string, data: string) => {
    const session = owned(event.sender, id)
    if (typeof data !== 'string' || data.length > 1024 * 1024)
      throw new Error('Invalid terminal input')
    if (session.exitCode === undefined) session.process.write(data)
  })
  ipcMain.handle('local-terminal:resize', (event, id: string, cols: number, rows: number) => {
    const session = owned(event.sender, id)
    if (![cols, rows].every((n) => Number.isInteger(n) && n > 0 && n <= 1000))
      throw new Error('Invalid terminal size')
    if (session.exitCode === undefined) session.process.resize(cols, rows)
  })
  ipcMain.handle('local-terminal:close', (event, id: string) => {
    owned(event.sender, id)
    close(id)
  })
}
