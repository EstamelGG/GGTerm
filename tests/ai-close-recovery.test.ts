// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { useAiStore, type AiSession } from '../src/renderer/src/stores/ai'
import { useWorkspaceIssues } from '../src/renderer/src/stores/workspaceIssues'
const close = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  useWorkspaceIssues.setState({ issues: {} })
  useAiStore.setState({
    sessions: ['one', 'two'].map((id) => ({
      id,
      title: id,
      messages: [],
      status: 'ready',
      loaded: true,
      createdAt: 1,
      updatedAt: 1
    })) as AiSession[],
    activeId: 'one'
  })
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: { ai: { closeSession: close } }
  })
})
it('keeps a session until close succeeds, coalesces repeats and preserves newer navigation', async () => {
  let finish!: () => void
  close.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const pending = useAiStore.getState().closeSession('one')
  await useAiStore.getState().closeSession('one')
  expect(close).toHaveBeenCalledOnce()
  expect(useAiStore.getState().sessions).toHaveLength(2)
  useAiStore.setState({ activeId: 'two' })
  finish()
  await pending
  expect(useAiStore.getState().sessions.map((s) => s.id)).toEqual(['two'])
  expect(useAiStore.getState().activeId).toBe('two')
})
it('retains failed sessions and allows an explicit retry', async () => {
  close.mockRejectedValueOnce(new Error('Cleanup failed')).mockResolvedValue(undefined)
  await useAiStore.getState().closeSession('one')
  expect(useAiStore.getState().sessions).toHaveLength(2)
  expect(useWorkspaceIssues.getState().issues['ai:close:one'].message).toBe('Cleanup failed')
  await useWorkspaceIssues.getState().retry('ai:close:one')
  expect(useAiStore.getState().sessions.map((s) => s.id)).toEqual(['two'])
  expect(useWorkspaceIssues.getState().issues['ai:close:one']).toBeUndefined()
})
