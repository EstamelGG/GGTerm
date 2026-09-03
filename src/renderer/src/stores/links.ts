import { create } from 'zustand'
import type { HostLinkSnapshot, HostStateEvent, SshConnectionSession } from '@shared/types'

/**
 * 主机链路相位（全局单例）：连接列表的状态列与 AI 拓扑图共用同一份数据。
 * 主进程是唯一权威 —— 启动拉一次全量快照（listLinks），此后由 host:state 增量更新；
 * 因此即使拓扑图未挂载，也能随时回答"这台现在连没连上"。
 */
interface LinksState {
  byHost: Record<string, HostLinkSnapshot>
  /** App 启动时接线一次（幂等）：拉快照 + 订阅增量，返回取消订阅函数 */
  watch: () => () => void
}

function toSnapshot(e: HostStateEvent): HostLinkSnapshot {
  return {
    hostId: e.hostId,
    phase: e.phase,
    since: e.since,
    attempt: e.attempt,
    reason: e.reason,
    // 实际建立/正在拨的跳板链（事实）：拓扑图按它画边
    jumpIds: e.jumpIds
  }
}

export const useLinksStore = create<LinksState>((set) => ({
  byHost: {},

  watch: () => {
    let active = true
    const userLinks: Record<string, HostLinkSnapshot> = {}
    const agentLinks = new Map<string, SshConnectionSession>()
    const updatedAgents = new Set<string>()
    const rank = { connected: 0, connecting: 1, reconnecting: 2, offline: 3, idle: 4 }
    const publish = (): void => {
      const byHost = { ...userLinks }
      for (const link of agentLinks.values()) {
        const current = byHost[link.hostId]
        if (
          !current ||
          rank[link.phase] < rank[current.phase] ||
          (link.phase === current.phase && link.since > current.since)
        )
          byHost[link.hostId] = link
      }
      set({ byHost })
    }
    const updated = new Set<string>()
    const off = window.aterm.hosts.onState((e: HostStateEvent) => {
      updated.add(e.hostId)
      userLinks[e.hostId] = toSnapshot(e)
      publish()
    })
    const offAgent = window.aterm.hosts.onAgentState((event) => {
      updatedAgents.add(event.connectionId)
      agentLinks.set(event.connectionId, event)
      publish()
    })
    void window.aterm.hosts
      .listAgentLinks()
      .then((snapshot) => {
        if (!active) return
        for (const link of snapshot)
          if (!updatedAgents.has(link.connectionId)) agentLinks.set(link.connectionId, link)
        publish()
      })
      .catch(() => {})
    void window.aterm.hosts
      .listLinks()
      .then((snapshot) => {
        if (!active) return
        // 快照请求期间收到的实时事件比快照新，不能被迟到的快照覆盖。
        for (const link of snapshot) {
          if (!updated.has(link.hostId)) userLinks[link.hostId] = link
        }
        publish()
      })
      .catch(() => {
        // 初始化失败时仍保留实时订阅，后续状态事件可以恢复镜像。
      })
    return () => {
      active = false
      off()
      offAgent()
    }
  }
}))
