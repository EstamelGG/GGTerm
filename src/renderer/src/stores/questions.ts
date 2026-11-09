import { create } from 'zustand'
import type { AgentQuestion } from '@shared/agentQuestion'
import { watchSnapshot } from '@/lib/watchSnapshot'
import { useWorkspaceIssues } from './workspaceIssues'
export const useQuestionsStore = create<{
  pending: Record<string, AgentQuestion>
  watch: () => () => void
}>((set) => ({
  pending: {},
  watch: () =>
    watchSnapshot({
      load: () => window.aterm.questions.list(),
      key: (question) => question.toolCallId,
      replace: (items) => set({ pending: Object.fromEntries(items.map((q) => [q.toolCallId, q])) }),
      upsert: (question) =>
        set((s) => ({ pending: { ...s.pending, [question.toolCallId]: question } })),
      remove: (id) =>
        set((s) => {
          const pending = { ...s.pending }
          delete pending[id]
          return { pending }
        }),
      listen: (upsert, remove) => {
        const offRequest = window.aterm.questions.onRequest(upsert)
        const offResolved = window.aterm.questions.onResolved(remove)
        return () => {
          offRequest()
          offResolved()
        }
      },
      failed: (error, retry) =>
        useWorkspaceIssues.getState().report('questions', error, 'recovery', retry),
      restored: () => useWorkspaceIssues.getState().clear('questions')
    })
}))
