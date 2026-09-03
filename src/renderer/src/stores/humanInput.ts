import { create } from 'zustand'
import type { HumanInputRequest, HumanInputResolved } from '@shared/execution'

/**
 * 人工输入待办（渲染层镜像）：主进程 human-input:request / resolved 实时推送；
 * 启动或窗口刷新时经 humanInput.list() 恢复（执行本身一直挂在主进程上）。
 * 按 executionId 索引 —— 工具卡只订阅自己那一条，避免全局重渲染。
 * 注意：待办里只有提示文本与上下文，**不含**任何已提交的值。
 */
interface HumanInputState {
  pending: Record<string, HumanInputRequest>
  request: (request: HumanInputRequest) => void
  resolve: (info: HumanInputResolved) => void
  replaceAll: (list: HumanInputRequest[]) => void
}

export const useHumanInputStore = create<HumanInputState>((set) => ({
  pending: {},

  request: (request) =>
    set((s) => ({ pending: { ...s.pending, [request.executionId]: request } })),

  resolve: ({ executionId }) =>
    set((s) => {
      if (!s.pending[executionId]) return s
      const pending = { ...s.pending }
      delete pending[executionId]
      return { pending }
    }),

  replaceAll: (list) =>
    set({ pending: Object.fromEntries(list.map((r) => [r.executionId, r])) })
}))
