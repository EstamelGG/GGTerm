import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { patchWindowsPty } from '../scripts/pty-windows-patch.mjs'

const require = createRequire(import.meta.url)
const root = dirname(require.resolve('node-pty/package.json'))
const source = patchWindowsPty(
  readFileSync(join(root, 'lib/windowsPtyAgent.js'), 'utf8').replace(/\r\n/g, '\n'),
  readFileSync(join(root, 'lib/conpty_console_list_agent.js'), 'utf8').replace(/\r\n/g, '\n')
)
function methods(fork = vi.fn()): { prototype: object; kill: ReturnType<typeof vi.fn> } {
  const start = source.agent.indexOf('    WindowsPtyAgent.prototype.kill =')
  const end = source.agent.indexOf(
    '    Object.defineProperty(WindowsPtyAgent.prototype, "exitCode"',
    start
  )
  const Agent = function (): void {
    /* Methods are installed by the upstream source. */
  }
  const kill = vi.fn()
  runInNewContext(source.agent.slice(start, end), {
    WindowsPtyAgent: Agent,
    child_process_1: { fork },
    path: { join },
    __dirname: root,
    process: { kill },
    setTimeout,
    clearTimeout,
    console: { error: vi.fn() }
  })
  return { prototype: Agent.prototype, kill }
}
afterEach(() => vi.useRealTimers())

it('is idempotent and refuses silently patching changed upstream code', () => {
  expect(patchWindowsPty(source.agent, source.helper)).toEqual(source)
  expect(() => patchWindowsPty('changed', source.helper)).toThrow(/target changed/)
})

it('keeps the console alive until enumeration finishes and releases it once', async () => {
  const { prototype, kill } = methods()
  let resolve!: (pids: number[]) => void
  const nativeKill = vi.fn(),
    dispose = vi.fn()
  const agent = Object.assign(Object.create(prototype), {
    _useConpty: true,
    _useConptyDll: false,
    _inSocket: {},
    _outSocket: {},
    _ptyNative: { kill: nativeKill },
    _conoutSocketWorker: { dispose },
    _getConsoleProcessList: vi.fn(
      () =>
        new Promise<number[]>((r) => {
          resolve = r
        })
    )
  })
  agent.kill()
  agent.kill()
  expect(nativeKill).not.toHaveBeenCalled()
  expect(agent._getConsoleProcessList).toHaveBeenCalledOnce()
  resolve([12, 13])
  await Promise.resolve()
  expect(kill.mock.calls).toEqual([[12], [13]])
  expect(nativeKill).toHaveBeenCalledOnce()
  expect(dispose).toHaveBeenCalledOnce()
})

it.each(['exit', 'error', 'timeout', 'message'])(
  'settles helper %s and clears the fallback timer',
  async (event) => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    const fork = vi.fn(() => child)
    const { prototype } = methods(fork)
    const agent = Object.assign(Object.create(prototype), { _innerPid: 23 })
    const result = agent._getConsoleProcessList()
    expect(fork.mock.calls[0][2]).toEqual({ windowsHide: true })
    if (event === 'timeout') await vi.advanceTimersByTimeAsync(5000)
    else
      child.emit(
        event,
        event === 'message' ? { consoleProcessList: [23, 24] } : new Error('failed')
      )
    expect(await result).toEqual(event === 'message' ? [23, 24] : [23])
    expect(vi.getTimerCount()).toBe(0)
  }
)

it('suppresses AttachConsole failure only for an already exited shell', () => {
  const error = new Error('AttachConsole failed')
  const send = vi.fn()
  const context = {
    exports: {},
    require: () => ({
      loadNativeModule: () => ({
        module: {
          getConsoleProcessList: () => {
            throw error
          }
        }
      })
    }),
    process: {
      argv: ['', '', '23'],
      send,
      exit: vi.fn(),
      kill: () => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      }
    }
  }
  runInNewContext(source.helper, context)
  expect(send.mock.calls[0][0]).toEqual({ consoleProcessList: [] })
  expect(() =>
    runInNewContext(source.helper, {
      exports: {},
      require: context.require,
      process: { ...context.process, kill: vi.fn() }
    })
  ).toThrow('AttachConsole failed')
})
