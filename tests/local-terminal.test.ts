import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

type Handler = Parameters<typeof import('electron').ipcMain.handle>[1]
interface MockChild {
  data: (data: string) => void
  exit: (event: { exitCode: number }) => void
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
}
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  children: [] as MockChild[]
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: Handler) => mocks.handlers.set(name, fn) }
}))
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const child = {
      data: vi.fn<(data: string) => void>(),
      exit: vi.fn<(event: { exitCode: number }) => void>(),
      onData(fn: (data: string) => void) {
        this.data = fn
      },
      onExit(fn: (event: { exitCode: number }) => void) {
        this.exit = fn
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn()
    }
    mocks.children.push(child)
    return child
  })
}))
import {
  disposeLocalTerminals,
  installLocalTerminals,
  registerLocalTerminalIpc
} from '../src/main/localTerminal'

function owner(): WebContents {
  return Object.assign(new EventEmitter(), {
    send: vi.fn(),
    isDestroyed: () => false,
    mainFrame: {}
  }) as unknown as WebContents
}
const call = (name: string, sender: WebContents, ...args: unknown[]): ReturnType<Handler> =>
  mocks.handlers.get(`local-terminal:${name}`)!(
    { sender, senderFrame: sender.mainFrame } as Parameters<Handler>[0],
    ...args
  )
beforeEach(() => {
  disposeLocalTerminals()
  mocks.children.length = 0
  registerLocalTerminalIpc()
})

it('preserves output and a fast shell exit until the renderer is ready', () => {
  const sender = owner()
  installLocalTerminals(sender)
  const session = call('create', sender)
  const child = mocks.children[0]
  child.data('中文 prompt')
  child.exit({ exitCode: 7 })
  expect(sender.send).not.toHaveBeenCalled()
  call('ready', sender, session.id)
  expect(sender.send).toHaveBeenNthCalledWith(1, 'local-terminal:event', {
    type: 'data',
    id: session.id,
    data: '中文 prompt'
  })
  expect(sender.send).toHaveBeenNthCalledWith(2, 'local-terminal:event', {
    type: 'exit',
    id: session.id,
    exitCode: 7
  })
  call('ready', sender, session.id)
  expect(sender.send).toHaveBeenCalledTimes(2)
  call('write', sender, session.id, 'ignored')
  expect(child.write).not.toHaveBeenCalled()
})

it('rejects untrusted creation and cross-window access, validates dimensions, and cleans up on reload', () => {
  const sender = owner()
  const other = owner()
  expect(() => call('create', other)).toThrow('only available')
  installLocalTerminals(sender)
  const { id } = call('create', sender)
  const child = mocks.children[0]
  expect(() => call('write', other, id, 'whoami\r')).toThrow('not found')
  expect(() => call('resize', sender, id, 0, 24)).toThrow('Invalid')
  expect(() => call('resize', sender, id, 80, NaN)).toThrow('Invalid')
  call('write', sender, id, '\x03')
  call('resize', sender, id, 120, 40)
  expect(child.write).toHaveBeenCalledWith('\x03')
  expect(child.resize).toHaveBeenCalledWith(120, 40)
  sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  expect(child.kill).not.toHaveBeenCalled()
  sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(child.kill).toHaveBeenCalledOnce()
  expect(() => call('ready', sender, id)).toThrow('not found')
})

it('pauses excessive startup output, resumes after readiness, and stops on window destruction', () => {
  const sender = owner()
  installLocalTerminals(sender)
  const { id } = call('create', sender)
  const child = mocks.children[0]
  child.data('x'.repeat(1024 * 1024))
  expect(child.pause).toHaveBeenCalledOnce()
  call('ready', sender, id)
  expect(child.resume).toHaveBeenCalledOnce()
  sender.emit('destroyed')
  expect(child.kill).toHaveBeenCalledOnce()
})
