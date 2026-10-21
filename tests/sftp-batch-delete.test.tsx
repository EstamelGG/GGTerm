// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SftpPane } from '../src/renderer/src/components/sftp/SftpPane'
import { useSftpStore } from '../src/renderer/src/stores/sftp'
import type { SftpEntry } from '../src/shared/types'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/stores/ai', () => ({ useAiStore: {} }))
vi.mock('../src/renderer/src/stores/session', () => ({ useSessionStore: {} }))
vi.mock('../src/renderer/src/stores/workspace', () => ({ useWorkspaceStore: {} }))

const original = useSftpStore.getState()
const remove = vi.fn(async () => {})
const realpath = vi.fn(async (_host: string, path: string) => path)
const entry = (path: string, isDir = false): SftpEntry => ({
  path,
  name: path.split('/').pop()!,
  isDir,
  isLink: false,
  size: 0,
  permissions: null,
  uid: null,
  gid: null,
  accessed: null,
  modified: null,
  longname: '',
  linkTarget: null
})
const files = [entry('/work/a'), entry('/work/b'), entry('/work/c')]

beforeEach(() => {
  remove.mockClear()
  realpath.mockReset().mockImplementation(async (_host, path) => path)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(): void {
        this.callback(
          [{ contentRect: { width: 400, height: 400 } }] as ResizeObserverEntry[],
          this as unknown as ResizeObserver
        )
      }
      disconnect = vi.fn()
      unobserve = vi.fn()
    }
  )
  Object.defineProperty(window, 'aterm', { configurable: true, value: { sftp: { realpath } } })
  useSftpStore.setState({
    ensureStarted: vi.fn(),
    remove,
    panes: {
      host: {
        started: true,
        status: 'connected',
        error: null,
        root: '/work',
        home: '/work',
        path: '/work',
        children: { '/work': files },
        errors: {},
        expanded: [],
        showHidden: true,
        loadingPaths: [],
        loading: false,
        banner: null,
        transfers: [],
        focusedPath: null
      }
    }
  })
})
afterEach(() => {
  cleanup()
  useSftpStore.setState(original, true)
  vi.unstubAllGlobals()
})

function setup(): ReturnType<typeof render> {
  return render(
    <SftpPane hostId="host" onToast={vi.fn()} onOpenTerminal={vi.fn()} onOpenFile={vi.fn()} />
  )
}

function row(name: string): HTMLElement {
  return screen.getByText(name).closest('[data-sftp-path]') as HTMLElement
}

it('deletes the entire multi-selection from the context menu only after confirmation', async () => {
  setup()
  fireEvent.click(row('a'))
  fireEvent.click(row('b'), { ctrlKey: true })
  fireEvent.contextMenu(row('a'))
  fireEvent.click(await screen.findByRole('menuitem', { name: /common.delete \(2\)/ }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('/work/a')).toBeTruthy()
  expect(within(dialog).getByText('/work/b')).toBeTruthy()
  expect(remove).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'common.delete' }))
  expect(remove.mock.calls).toEqual([
    ['host', files[0]],
    ['host', files[1]]
  ])
})

it('right-clicking an unselected row deletes only that row and cancellation keeps files', async () => {
  setup()
  fireEvent.click(row('a'))
  fireEvent.click(row('b'), { metaKey: true })
  fireEvent.contextMenu(row('c'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'common.delete' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('/work/c')).toBeTruthy()
  expect(realpath.mock.calls).toEqual([['host', '/work/c']])
  fireEvent.click(within(dialog).getByRole('button', { name: 'common.cancel' }))
  expect(remove).not.toHaveBeenCalled()
})

it('offers toolbar deletion for shift selection and reports path resolution failures', async () => {
  setup()
  expect(
    (screen.getByRole('button', { name: 'common.delete' }) as HTMLButtonElement).disabled
  ).toBe(true)
  fireEvent.click(row('a'))
  fireEvent.click(row('c'), { shiftKey: true })
  realpath.mockRejectedValueOnce(new Error('permission denied'))
  fireEvent.click(screen.getByRole('button', { name: 'common.delete (3)' }))
  await waitFor(() => expect(screen.getByText('permission denied')).toBeTruthy())
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(remove).not.toHaveBeenCalled()
})

it('deletes a selected parent only once when its child is also selected', async () => {
  const folder = entry('/work/folder', true)
  const child = entry('/work/folder/child')
  const pane = useSftpStore.getState().panes.host
  useSftpStore.setState({
    panes: {
      host: {
        ...pane,
        children: { '/work': [folder], [folder.path]: [child] },
        expanded: [folder.path]
      }
    }
  })
  setup()
  fireEvent.click(row('folder'))
  fireEvent.click(row('child'), { ctrlKey: true })
  fireEvent.click(screen.getByRole('button', { name: 'common.delete (2)' }))
  const dialog = await screen.findByRole('dialog')
  expect(realpath.mock.calls).toEqual([['host', folder.path]])
  fireEvent.click(within(dialog).getByRole('button', { name: 'common.delete' }))
  expect(remove.mock.calls).toEqual([['host', folder]])
  expect(
    (screen.getByRole('button', { name: 'common.delete' }) as HTMLButtonElement).disabled
  ).toBe(true)
})
