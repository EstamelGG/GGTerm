import { applyAccent, applyBgTransparency, applyUiScale } from '@/lib/accent'
import { useAiStore } from '@/stores/ai'
import { useConnectionsStore } from '@/stores/connections'
import { useExecutionTabs } from '@/stores/executionTabs'
import { useHumanInputStore } from '@/stores/humanInput'
import { useLinksStore } from '@/stores/links'
import { useLogStore } from '@/stores/logs'
import { usePerfStore } from '@/stores/perf'
import { usePrefsStore } from '@/stores/prefs'
import { useQuestionsStore } from '@/stores/questions'
import { pumpShellAnnounce, pumpShellData, useSessionStore } from '@/stores/session'
import { useSftpStore } from '@/stores/sftp'
import { useWorkspaceIssues } from '@/stores/workspaceIssues'
import { applyTerminalFontSize } from '@/terminal/registry'
import i18next from 'i18next'
import { useEffect } from 'react'

/** Own all application-level subscriptions and their cleanup in one mounted hook. */
export function useAppRuntime(flash: (text: string, danger?: boolean) => void): void {
  const connections = useConnectionsStore((s) => s.connections)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async (): Promise<void> => {
      const sessions = useAiStore.getState().sessions
      const results = await Promise.allSettled(
        sessions.map((s) => window.aterm.executions.list(s.id))
      )
      if (!active) return
      const tasks = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
      useExecutionTabs.getState().sync(tasks)
      timer = setTimeout(() => void refresh(), 1000)
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [])
  useEffect(() => {
    useSessionStore.setState((state) => ({
      hosts: state.hosts.map((h) => {
        const conn = connections.find((c) => c.id === h.id)
        return conn && conn !== h.conn ? { ...h, conn, title: conn.name } : h
      })
    }))
  }, [connections])
  // 挂载后移除静态启动画面（见 index.html）
  useEffect(() => {
    document.getElementById('splash')?.remove()
  }, [])

  // 偏好 + 全局主机/shell 事件管道
  useEffect(() => {
    let active = true
    const loadPreferences = async (): Promise<void> => {
      try {
        await usePrefsStore.getState().load()
        if (!active) return
        const p = usePrefsStore.getState().data
        if (p) {
          applyAccent(p.accentHex)
          applyBgTransparency(p.bgTransparency)
          applyUiScale(p.uiScale)
          applyTerminalFontSize(p.terminalFontSize)
        }
        useWorkspaceIssues.getState().clear('preferences')
      } catch (error) {
        if (active)
          useWorkspaceIssues.getState().report('preferences', error, 'preferences', loadPreferences)
      }
    }
    void loadPreferences()
    const offHost = useLinksStore.subscribe((next, previous) => {
      for (const [hostId, state] of Object.entries(next.userByHost)) {
        if (
          state !== previous.userByHost[hostId] &&
          !useSessionStore.getState().hosts.some((host) => host.id === hostId && host.viewerOnly)
        )
          useSessionStore.getState().applyHostState(state)
      }
      for (const host of useSessionStore.getState().hosts) {
        if (!host.viewerOnly) continue
        const state = next.byHost[host.id]
        if (state && state !== previous.byHost[host.id])
          useSessionStore.getState().applyHostState(state)
      }
    })
    // 链路相位全局镜像：连接列表状态列与拓扑图共用（主进程为唯一权威）
    const offLinks = useLinksStore.getState().watch()
    const offShell = window.aterm.shells.onState((e) =>
      useSessionStore.getState().applyShellState(e)
    )
    const offData = window.aterm.shells.onData(pumpShellData)
    const offAnnounce = window.aterm.shells.onAnnounce(pumpShellAnnounce)
    const offSftpState = window.aterm.sftp.onState((e) =>
      useSftpStore.getState().applyStateEvent(e)
    )
    const offSftpTransfer = window.aterm.sftp.onTransfer((e) =>
      useSftpStore.getState().applyTransferEvent(e)
    )
    const offPerf = window.aterm.perf.onSample((e) => usePerfStore.getState().apply(e))
    const offPerfGpu = window.aterm.perf.onGpu((e) => usePerfStore.getState().applyGpu(e))
    const offOs = window.aterm.perf.onOs((e) => usePerfStore.getState().applyOs(e))
    // 任意来源（表单/agent tool/导入）的连接增删改 → 全量刷新目录数据
    const offConnChanged = window.aterm.connections.onChange(
      () =>
        void useConnectionsStore
          .getState()
          .load()
          .catch((error) => useWorkspaceIssues.getState().report('catalog', error, 'recovery'))
    )
    const offLog = window.aterm.logs.onLog((e) => useLogStore.getState().append(e))
    const offLogOpen = window.aterm.logs.onOpen(() => {
      const s = useLogStore.getState()
      s.setOpen(true)
      s.setCollapsed(false) // 折叠态下再次呼出 → 展开
    })
    const offAiEvent = window.aterm.ai.onEvent((e) => {
      useAiStore.getState().applyEvent(e)
      // 人工审批请求（非规则自动决策）到达时提示
      if (e.type === 'chunk' && e.chunk.type === 'tool-approval-request' && !e.chunk.isAutomatic)
        flash(i18next.t('ai.approvalToast'))
    })
    // 人工输入待办（密码/验证码）：主进程推送 → 对应工具卡挂出输入区；启动时恢复未收尾的待办
    const offQuestions = useQuestionsStore.getState().watch()
    const offHumanInput = useHumanInputStore
      .getState()
      .watch(() => flash(i18next.t('ai.inputToast')))
    return () => {
      active = false
      offQuestions()
      offHost()
      offLinks()
      offShell()
      offData()
      offAnnounce()
      offSftpState()
      offSftpTransfer()
      offPerf()
      offPerfGpu()
      offOs()
      offConnChanged()
      offLog()
      offLogOpen()
      offAiEvent()
      offHumanInput()
    }
  }, [flash])
}
