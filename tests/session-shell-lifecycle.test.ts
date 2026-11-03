// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { useSessionStore } from '../src/renderer/src/stores/session'
import type { HostConnection } from '../src/shared/types'

const terminal = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  disposeTerminal: vi.fn(),
  loading: vi.fn(),
  gate: null as Promise<void> | null
}))
vi.mock('../src/renderer/src/terminal/registry', async () => {
  terminal.loading()
  await terminal.gate
  return { createTerminal: terminal.createTerminal, disposeTerminal: terminal.disposeTerminal }
})
vi.mock('../src/renderer/src/stores/sftp', () => ({
  useSftpStore: { getState: () => ({ dropHost: vi.fn() }) }
}))
afterEach(() => {
  useSessionStore.setState({ hosts: [], tab: { kind: 'connections' } })
  vi.clearAllMocks()
})

it('discards a shell when its workspace closes during the terminal module load', async () => {
  let release!: () => void
  terminal.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const close = vi.fn()
  const start = vi.fn()
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      hosts: { connect: vi.fn(async () => ({ awaiting: false })) },
      shells: { create: async () => ({ shellId: 'loading-shell' }), close, start }
    }
  })
  await useSessionStore
    .getState()
    .connect({ id: 'loading-host', name: 'Host' } as HostConnection, false)
  useSessionStore.getState().addShell('loading-host')
  try {
    await vi.waitFor(() => expect(terminal.loading).toHaveBeenCalled())
    useSessionStore.getState().detachHost('loading-host')
  } finally {
    release()
    terminal.gate = null
  }
  await vi.waitFor(() => expect(close).toHaveBeenCalledWith('loading-host', 'loading-shell'))
  expect(terminal.createTerminal).not.toHaveBeenCalled()
  expect(start).not.toHaveBeenCalled()
})

it.each([false, true])(
  'discards a late shell reply after closing its workspace (reopen=%s)',
  async (reopen) => {
    let reply!: (result: { shellId: string }) => void
    const close = vi.fn()
    const start = vi.fn()
    Object.defineProperty(window, 'aterm', {
      configurable: true,
      value: {
        hosts: { connect: vi.fn(async () => ({ awaiting: false })) },
        shells: {
          create: () =>
            new Promise((resolve) => {
              reply = resolve
            }),
          close,
          start
        }
      }
    })
    const conn = { id: 'host', name: 'Host' } as HostConnection
    await useSessionStore.getState().connect(conn, false)
    useSessionStore.getState().addShell(conn.id)
    useSessionStore.getState().detachHost(conn.id)
    if (reopen) await useSessionStore.getState().connect(conn, false)
    reply({ shellId: 'old-shell' })
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith('host', 'old-shell'))
    expect(terminal.createTerminal).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(useSessionStore.getState().hosts.flatMap((host) => host.shells)).toEqual([])
  }
)

it('still creates and starts a shell for a live workspace', async () => {
  const start = vi.fn()
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      hosts: { connect: vi.fn(async () => ({ awaiting: false })) },
      shells: { create: async () => ({ shellId: 'live-shell' }), close: vi.fn(), start }
    }
  })
  await useSessionStore
    .getState()
    .connect({ id: 'live-host', name: 'Host' } as HostConnection, false)
  useSessionStore.getState().addShell('live-host')
  await vi.waitFor(() => expect(start).toHaveBeenCalledWith('live-host', 'live-shell'))
  expect(terminal.createTerminal).toHaveBeenCalledTimes(1)
  expect(useSessionStore.getState().hosts[0].shells).toMatchObject([{ id: 'live-shell' }])
})
