import { create } from 'zustand'

/** 对照 HostLatencyProbe.Status */
export type LatencyStatus = 'idle' | 'probing' | number | 'unreachable'

interface ProbeTargetInput {
  id: string
  host: string
  port: number
}

interface LatencyState {
  status: Record<string, LatencyStatus>
  refresh: (targets: ProbeTargetInput[]) => void
}

/** 对照 HostLatencyProbe：重测保留上次结果、仅新条目显示 probing；每台独立回包独立上屏 */
export const useLatencyStore = create<LatencyState>((set) => ({
  status: {},
  refresh: (targets) => {
    const prev = useLatencyStore.getState().status
    const next: Record<string, LatencyStatus> = {}
    let hasNew = false
    for (const t of targets) {
      const existing = prev[t.id]
      if (existing === undefined) hasNew = true
      next[t.id] = existing ?? 'probing'
    }
    // 无新目标时不写 store：内容相同的重复 refresh 不得产生新引用（防同步重渲染环）
    if (hasNew) set((state) => ({ status: { ...state.status, ...next } }))

    // 每台主机独立请求独立落 store：谁先回包谁先显示，不互相等待
    for (const target of targets) {
      void window.aterm.probe
        .latency([target])
        .then((results) => {
          const result = results.find((r) => r.id === target.id)
          if (!result) return
          set((state) => ({
            status: { ...state.status, [target.id]: result.ms ?? 'unreachable' }
          }))
        })
        .catch(() => {})
    }
  }
}))
