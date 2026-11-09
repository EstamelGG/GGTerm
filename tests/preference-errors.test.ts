// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { usePrefsStore } from '../src/renderer/src/stores/prefs'
import { useWorkspaceIssues } from '../src/renderer/src/stores/workspaceIssues'

vi.mock('../src/renderer/src/lib/accent', () => ({
  applyAccent: vi.fn(),
  applyBgTransparency: vi.fn(),
  applyUiScale: vi.fn()
}))
vi.mock('../src/renderer/src/terminal/registry', () => ({ applyTerminalFontSize: vi.fn() }))
const set = vi.fn(),
  get = vi.fn(),
  apply = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  usePrefsStore.setState({ data: null })
  useWorkspaceIssues.setState({ issues: {} })
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: { prefs: { set, get }, locale: { apply } }
  })
})
it('propagates loading failure to the application recovery handler', async () => {
  get.mockRejectedValue(new Error('Cannot read preferences'))
  await expect(usePrefsStore.getState().load()).rejects.toThrow('Cannot read preferences')
  expect(usePrefsStore.getState().data).toBeNull()
})
it('exposes failed writes and retries without losing the preview', async () => {
  set.mockRejectedValueOnce(new Error('Disk full')).mockResolvedValue(undefined)
  usePrefsStore.getState().update({ uiScale: 120 })
  await Promise.resolve()
  const scope = 'preferences:save:uiScale'
  expect(useWorkspaceIssues.getState().issues[scope].message).toBe('Disk full')
  expect(usePrefsStore.getState().data?.uiScale).toBe(120)
  await useWorkspaceIssues.getState().retry(scope)
  expect(set).toHaveBeenLastCalledWith({ uiScale: 120 })
  expect(useWorkspaceIssues.getState().issues[scope]).toBeUndefined()
})
it('does not resurrect a stale save error after a newer preference change', async () => {
  let fail!: (e: Error) => void
  set
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject
        })
    )
    .mockResolvedValue(undefined)
  usePrefsStore.getState().update({ uiScale: 120 })
  usePrefsStore.getState().update({ uiScale: 125 })
  fail(new Error('Old failure'))
  await Promise.resolve()
  expect(useWorkspaceIssues.getState().issues).toEqual({})
})
it('uses acknowledged language changes and exposes their failure', async () => {
  apply.mockRejectedValue(new Error('Cannot change language'))
  usePrefsStore.getState().update({ locale: 'en' })
  await Promise.resolve()
  expect(set).not.toHaveBeenCalled()
  expect(apply).toHaveBeenCalledWith('en')
  expect(useWorkspaceIssues.getState().issues['preferences:save:locale'].message).toBe(
    'Cannot change language'
  )
})
