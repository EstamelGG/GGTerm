import { create } from 'zustand'
import { errorMessage } from '@shared/error'

export type WorkspaceIssueKind = 'recovery' | 'shell' | 'credentials' | 'preferences'
interface WorkspaceIssue {
  message: string
  kind: WorkspaceIssueKind
  retry?: () => void | Promise<void>
  pending?: boolean
}
interface IssuesState {
  issues: Record<string, WorkspaceIssue>
  report: (
    scope: string,
    error: unknown,
    kind: WorkspaceIssueKind,
    retry?: WorkspaceIssue['retry']
  ) => void
  clear: (scope: string) => void
  retry: (scope: string) => Promise<void>
}
export const useWorkspaceIssues = create<IssuesState>((set, get) => ({
  issues: {},
  report: (scope, error, kind, retry) =>
    set((s) => ({
      issues: { ...s.issues, [scope]: { message: errorMessage(error), kind, retry } }
    })),
  clear: (scope) =>
    set((s) => {
      if (!s.issues[scope]) return s
      const issues = { ...s.issues }
      delete issues[scope]
      return { issues }
    }),
  retry: async (scope) => {
    const issue = get().issues[scope]
    if (!issue?.retry || issue.pending) return
    const busy = { ...issue, pending: true }
    set((s) => ({ issues: { ...s.issues, [scope]: busy } }))
    try {
      await issue.retry()
    } catch (error) {
      get().report(scope, error, issue.kind, issue.retry)
    } finally {
      if (get().issues[scope] === busy)
        set((s) => ({ issues: { ...s.issues, [scope]: { ...busy, pending: false } } }))
    }
  }
}))
