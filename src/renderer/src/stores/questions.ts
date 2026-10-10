import { create } from 'zustand'
import type { AgentQuestion } from '@shared/agentQuestion'
export const useQuestionsStore = create<{
  pending: Record<string, AgentQuestion>
  watch: () => () => void
}>(() => ({
  pending: {},
  watch: () => {
    let live = true
    const changed = new Set<string>()
    const request = window.aterm.questions.onRequest((question) => {
      changed.add(question.toolCallId)
      useQuestionsStore.setState((s) => ({
        pending: { ...s.pending, [question.toolCallId]: question }
      }))
    })
    const resolved = window.aterm.questions.onResolved((id) => {
      changed.add(id)
      useQuestionsStore.setState((s) => {
        const pending = { ...s.pending }
        delete pending[id]
        return { pending }
      })
    })
    void window.aterm.questions
      .list()
      .then((list) => {
        if (!live) return
        useQuestionsStore.setState((s) => ({
          pending: {
            ...Object.fromEntries(
              list.filter((q) => !changed.has(q.toolCallId)).map((q) => [q.toolCallId, q])
            ),
            ...Object.fromEntries(Object.entries(s.pending).filter(([id]) => changed.has(id)))
          }
        }))
      })
      .catch(() => {})
    return () => {
      live = false
      request()
      resolved()
    }
  }
}))
