// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { HumanInputRequest, HumanInputResolved } from '../src/shared/execution'
import { useHumanInputStore } from '../src/renderer/src/stores/humanInput'
import { useWorkspaceIssues } from '../src/renderer/src/stores/workspaceIssues'
afterEach(() => {
  useHumanInputStore.setState({ pending: {} })
  useWorkspaceIssues.setState({ issues: {} })
})
it('does not resurrect completed input or overwrite a new request with a late startup snapshot', async () => {
  let reply!: (items: HumanInputRequest[]) => void
  let request!: (item: HumanInputRequest) => void
  let resolved!: (item: HumanInputResolved) => void
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      humanInput: {
        list: () =>
          new Promise((resolve) => {
            reply = resolve
          }),
        onRequest: (fn: typeof request) => {
          request = fn
          return vi.fn()
        },
        onResolved: (fn: typeof resolved) => {
          resolved = fn
          return vi.fn()
        }
      }
    }
  })
  const stop = useHumanInputStore.getState().watch()
  resolved({ executionId: 'done' } as HumanInputResolved)
  request({ executionId: 'new', prompt: 'new question' } as HumanInputRequest)
  reply([
    { executionId: 'done' },
    { executionId: 'new', prompt: 'old question' }
  ] as HumanInputRequest[])
  await Promise.resolve()
  expect(Object.keys(useHumanInputStore.getState().pending)).toEqual(['new'])
  expect(useHumanInputStore.getState().pending.new.prompt).toBe('new question')
  stop()
  request({ executionId: 'late' } as HumanInputRequest)
  expect(useHumanInputStore.getState().pending.late).toBeUndefined()
})
it('recovers a failed snapshot through the shared retry action', async () => {
  const list = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce([{ executionId: 'restored' }])
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      humanInput: {
        list,
        onRequest: () => vi.fn(),
        onResolved: () => vi.fn()
      }
    }
  })
  const stop = useHumanInputStore.getState().watch()
  await Promise.resolve()
  expect(useWorkspaceIssues.getState().issues['human-input'].message).toBe('offline')
  await useWorkspaceIssues.getState().retry('human-input')
  expect(useHumanInputStore.getState().pending.restored).toBeDefined()
  expect(useWorkspaceIssues.getState().issues['human-input']).toBeUndefined()
  stop()
})
