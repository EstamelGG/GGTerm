// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { useSftpStore } from '../src/renderer/src/stores/sftp'

function setup(): {
  start: ReturnType<typeof vi.fn>
  realpath: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
} {
  const api = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    realpath: vi.fn().mockResolvedValue('/'),
    list: vi.fn().mockResolvedValue({ resolved: '/', entries: [] })
  }
  Object.defineProperty(window, 'aterm', { configurable: true, value: { sftp: api } })
  return api
}
afterEach(() => {
  useSftpStore.getState().dropHost('host')
  useSftpStore.setState({ panes: {} })
})

it('does not request directories after a delayed start completes for a closed pane', async () => {
  const api = setup()
  let resolve!: () => void
  api.start.mockReturnValueOnce(
    new Promise<void>((r) => {
      resolve = r
    })
  )
  useSftpStore.getState().ensureStarted('host')
  useSftpStore.getState().dropHost('host')
  resolve()
  await Promise.resolve()
  expect(api.realpath).not.toHaveBeenCalled()
  expect(useSftpStore.getState().panes.host).toBeUndefined()
})

it('does not attach an old startup response to a reopened pane for the same host', async () => {
  const api = setup()
  let resolve!: () => void
  api.start.mockReturnValueOnce(
    new Promise<void>((r) => {
      resolve = r
    })
  )
  useSftpStore.getState().ensureStarted('host')
  useSftpStore.getState().dropHost('host')
  useSftpStore.getState().ensureStarted('host')
  await vi.waitFor(() => expect(api.list).toHaveBeenCalledOnce())
  resolve()
  await Promise.resolve()
  expect(api.realpath).toHaveBeenCalledOnce()
  expect(useSftpStore.getState().panes.host.status).toBe('connected')
})

it('does not revive a closed pane when an in-flight directory listing finishes', async () => {
  const api = setup()
  let resolve!: (result: { resolved: string; entries: [] }) => void
  api.list.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r
    })
  )
  useSftpStore.getState().ensureStarted('host')
  await vi.waitFor(() => expect(api.list).toHaveBeenCalledOnce())
  useSftpStore.getState().dropHost('host')
  resolve({ resolved: '/', entries: [] })
  await Promise.resolve()
  await Promise.resolve()
  expect(useSftpStore.getState().panes.host).toBeUndefined()
})
