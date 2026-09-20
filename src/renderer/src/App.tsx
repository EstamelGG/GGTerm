import { OverflowTabs } from '@/components/chrome/OverflowTabs'
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import {
  LayoutGrid,
  Settings,
  Waypoints,
  PanelRightClose,
  PanelRightOpen,
  ScrollText
} from 'lucide-react'
import type { HostConnection } from '@shared/types'
import { cn } from '@/lib/utils'
import { linkStateDot } from '@/lib/linkPhase'
import { hexToCss } from '@/lib/theme'
import { IconButton } from '@/components/ui/IconButton'
import { TabChip } from '@/components/chrome/TabChip'
import { CloseTabsMenu } from '@/components/chrome/CloseTabsMenu'
import { isTab, pumpShellAnnounce, pumpShellData, useSessionStore } from '@/stores/session'
import { useSftpStore } from '@/stores/sftp'
import { usePerfStore } from '@/stores/perf'
import { useConnectionsStore } from '@/stores/connections'
import { useLinksStore } from '@/stores/links'
import { useLogStore } from '@/stores/logs'
import { isBusy, pendingApprovals, useAiStore } from '@/stores/ai'
import { usePrefsStore } from '@/stores/prefs'
import { useShallow } from 'zustand/react/shallow'
import { applyAccent, applyBgTransparency, applyUiScale } from '@/lib/accent'
import { applyTerminalFontSize } from '@/terminal/registry'
import { useWorkspaceStore } from '@/stores/workspace'
import ConnectionPage from '@/pages/ConnectionPage'
import { useHumanInputStore } from '@/stores/humanInput'

/** 终端页/主机页 lazy 分包：xterm、monaco 等重依赖移出首包（页面加载后实例照常常驻） */
const AiWorkspacePage = lazy(() => import('./pages/AiWorkspacePage'))
const HostSessionPage = lazy(() =>
  import('./pages/HostSessionPage').then((m) => ({ default: m.HostSessionPage }))
)
import { SettingsPage } from '@/pages/SettingsPage'
import { LogDrawer } from '@/components/logs/LogDrawer'
import { CloseDocumentsDialog } from '@/components/editor/CloseDocumentsDialog'
import { errorMessage } from '@shared/error'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'

/** 单行工作区 / 主机导航，下方主区域切换（页面常驻保实例）。 */
function App(): React.JSX.Element {
  const { t } = useTranslation()
  const tab = useSessionStore((s) => s.tab)
  const hosts = useSessionStore((s) => s.hosts)
  const setTab = useSessionStore((s) => s.setTab)
  const closeHost = useSessionStore((s) => s.closeHost)
  const connect = useSessionStore((s) => s.connect)
  // 链路相位（与连接列表同源）：header 主机 tab 状态点的唯一数据源。
  // 只订阅「已打开 tab」的相位序列 —— 订阅整张 byHost 会让**每个** host:state 都把根组件整树重渲染
  // （批量建连时一秒几十次），把扇出宽度收窄到眼前这几个 tab。
  const tabPhases = useLinksStore(useShallow((s) => hosts.map((h) => s.byHost[h.id]?.phase)))
  // 主机 tab 标题按所属分组色着色（未分组沿用默认配色）
  const connections = useConnectionsStore((s) => s.connections)
  const groups = useConnectionsStore((s) => s.groups)
  const aiNeedsAttention = useAiStore((s) =>
    s.sessions.some((session) => pendingApprovals(session.messages).length > 0)
  )
  const aiBusy = useAiStore((s) => s.sessions.some(isBusy))
  const aiNeedsInput = useHumanInputStore((s) => Object.keys(s.pending).length > 0)
  const aiOpen = useWorkspaceStore((s) => s.aiOpen)
  const setAiOpen = useWorkspaceStore((s) => s.setAiOpen)
  /** 日志面板开关态：非 macOS 用顶部按钮呼出（那里没有常驻菜单栏） */
  const logOpen = useLogStore((s) => s.open)

  /** 全局 toast：danger=true 时红色描边红字（密钥校验失败等错误提示） */
  const [toast, setToast] = useState<{ text: string; danger?: boolean } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pendingClose, setPendingClose] = useState<{ ids: string[]; quit: boolean } | null>(null)
  const prefs = usePrefsStore((s) => s.data)

  const flash = (text: string, danger = false): void => {
    setToast(danger ? { text, danger } : { text })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 4000)
  }
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
    },
    []
  )

  // 挂载后移除静态启动画面（见 index.html）
  useEffect(() => {
    document.getElementById('splash')?.remove()
  }, [])

  // 偏好 + 全局主机/shell 事件管道
  useEffect(() => {
    void usePrefsStore
      .getState()
      .load()
      .then(() => {
        const p = usePrefsStore.getState().data
        if (!p) return
        applyAccent(p.accentHex)
        applyBgTransparency(p.bgTransparency)
        applyUiScale(p.uiScale)
        applyTerminalFontSize(p.terminalFontSize)
      })
    const offHost = window.aterm.hosts.onState((e) => useSessionStore.getState().applyHostState(e))
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
      () => void useConnectionsStore.getState().load()
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
    const humanInput = useHumanInputStore.getState()
    const offInputRequest = window.aterm.humanInput.onRequest((request) => {
      humanInput.request(request)
      flash(i18next.t('ai.inputToast'))
    })
    const offInputResolved = window.aterm.humanInput.onResolved((info) => humanInput.resolve(info))
    void window.aterm.humanInput
      .list()
      .then(humanInput.replaceAll)
      .catch(() => {})
    return () => {
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
      offInputRequest()
      offInputResolved()
    }
  }, [])

  const openHost = (id: string): void => {
    const state = useSessionStore.getState()
    if (state.hosts.find((host) => host.id === id)?.shells.length === 0) state.addShell(id)
    setTab({ kind: 'host', id })
  }

  const handleConnect = (c: HostConnection): void => {
    void connect(c).catch((err) => flash(errorMessage(err)))
  }

  const requestClose = useCallback(
    (ids: string[], quit = false): void => {
      const state = useSessionStore.getState()
      const targets = state.hosts.filter((h) => ids.includes(h.id))
      const protectedFiles = targets.some((h) =>
        h.files.some((f) => f.text !== f.saved || f.saving)
      )
      const confirmSession = targets.length > 0 && (!quit || (prefs?.confirmCloseSession ?? true))
      if (protectedFiles || confirmSession) setPendingClose({ ids, quit })
      else if (quit) window.aterm.window.confirmClose()
      else ids.forEach((id) => closeHost(id))
    },
    [closeHost, prefs?.confirmCloseSession]
  )

  useEffect(
    () =>
      window.aterm.window.onCloseRequest(() =>
        requestClose(
          useSessionStore.getState().hosts.map((h) => h.id),
          true
        )
      ),
    [requestClose]
  )

  useEffect(() => {
    const preventReload = (event: BeforeUnloadEvent): void => {
      if (
        useSessionStore
          .getState()
          .hosts.some((h) => h.files.some((f) => f.text !== f.saved || f.saving))
      ) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', preventReload)
    return () => window.removeEventListener('beforeunload', preventReload)
  }, [])

  return (
    <div className="relative flex h-full flex-col bg-bg">
      {/* 单行导航：工作区入口固定，主机标签横滚，设置固定在右端。 */}
      <header
        className={cn(
          'drag flex h-10 shrink-0 items-center border-b border-chrome-sep bg-chrome-bar pr-3',
          window.aterm.window.platform === 'darwin' ? 'pl-[78px]' : 'pl-3'
        )}
      >
        <TabChip
          title={t('session.tabConnections')}
          icon={LayoutGrid}
          selected={tab.kind === 'connections'}
          onClick={() => setTab({ kind: 'connections' })}
        />
        <div className="w-2 shrink-0" />
        <TabChip
          title={t('session.tabTopology')}
          icon={Waypoints}
          selected={tab.kind === 'ai'}
          onClick={() => setTab({ kind: 'ai' })}
        />
        {hosts.length > 0 && <div className="mx-3 h-4 w-px shrink-0 bg-chrome-sep" />}
        <OverflowTabs
          tabs={hosts.map((host, idx) => ({
            id: host.id,
            title: host.title,
            selected: isTab(tab, { kind: 'host', id: host.id }),
            statusColor: linkStateDot(tabPhases[idx]),
            onSelect: () => openHost(host.id),
            content: (
              <ContextMenu key={host.id}>
                <ContextMenuTrigger asChild>
                  <TabChip
                    title={host.title}
                    statusColor={linkStateDot(tabPhases[idx])}
                    selected={isTab(tab, { kind: 'host', id: host.id })}
                    showClose
                    maxWidth={120}
                    titleColor={(() => {
                      const conn = connections.find((c) => c.id === host.id)
                      const group = conn?.groupId
                        ? groups.find((g) => g.id === conn.groupId)
                        : undefined
                      return group ? hexToCss(group.colorHex) : undefined
                    })()}
                    onClick={() => openHost(host.id)}
                    onClose={() => requestClose([host.id])}
                  />
                </ContextMenuTrigger>
                {/* 单个和批量关闭均保留未保存文件保护。 */}
                <CloseTabsMenu
                  onClose={() => requestClose([host.id])}
                  onCloseOthers={() =>
                    requestClose(hosts.filter((h) => h.id !== host.id).map((h) => h.id))
                  }
                  onCloseRight={() => requestClose(hosts.slice(idx + 1).map((h) => h.id))}
                  onCloseAll={() => requestClose(hosts.map((h) => h.id))}
                />
              </ContextMenu>
            )
          }))}
        />
        <div className="w-8 shrink-0" />
        {/* 日志面板入口：Windows/Linux 窗口菜单栏默认隐藏（autoHideMenuBar）,
            仅靠「视图 → 日志面板」无法触达，故在设置图标左侧常驻一个可见开关 */}
        {window.aterm.window.platform !== 'darwin' && (
          <div className="mr-1.5 shrink-0">
            <IconButton
              variant="toolbar"
              icon={ScrollText}
              title={t('logs.open')}
              selected={logOpen}
              onClick={() => {
                const logs = useLogStore.getState()
                if (logs.open) logs.setOpen(false)
                else {
                  logs.setOpen(true)
                  logs.setCollapsed(false)
                }
              }}
            />
          </div>
        )}
        <div className="shrink-0">
          <IconButton
            variant="toolbar"
            icon={Settings}
            aria-label={t('session.tabSettings')}
            selected={tab.kind === 'settings'}
            onClick={() =>
              setTab(tab.kind === 'settings' ? { kind: 'connections' } : { kind: 'settings' })
            }
          />
        </div>
        <div className="relative ml-1.5">
          <IconButton
            variant="toolbar"
            icon={aiOpen ? PanelRightClose : PanelRightOpen}
            title={t(aiOpen ? 'ai.hideSidebar' : 'ai.showSidebar')}
            aria-expanded={aiOpen}
            selected={aiOpen}
            onClick={() => setAiOpen(!aiOpen)}
          />
          {(aiBusy || aiNeedsAttention || aiNeedsInput) && (
            <span
              className={cn(
                'pointer-events-none absolute right-0 top-0 h-1.5 w-1.5 rounded-full',
                aiNeedsAttention || aiNeedsInput ? 'bg-danger' : 'bg-at-accent'
              )}
            />
          )}
        </div>
      </header>

      <main className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1">
          <ConnectionPage
            active={tab.kind === 'connections'}
            perfEnabled={!(prefs?.perfMonitorDisabled ?? false)}
            onToast={flash}
            onConnect={handleConnect}
          >
            <Suspense fallback={null}>
              <div className={cn('absolute inset-0', tab.kind !== 'settings' && 'hidden')}>
                <SettingsPage onToast={flash} />
              </div>
              {hosts
                .filter((host) => host.awaiting || (tab.kind === 'host' && tab.id === host.id))
                .map((host) => (
                  <div
                    key={host.id}
                    className={cn(
                      'absolute inset-0',
                      (tab.kind !== 'host' || tab.id !== host.id) && 'hidden'
                    )}
                  >
                    <HostSessionPage
                      host={host}
                      onToast={flash}
                      onClose={() => requestClose([host.id])}
                    />
                  </div>
                ))}
            </Suspense>
          </ConnectionPage>
        </div>
        <aside className={cn('h-full shrink-0', !aiOpen && 'hidden')} aria-label={t('ai.title')}>
          <Suspense fallback={null}>
            <AiWorkspacePage />
          </Suspense>
        </aside>
      </main>

      {/* 关闭主机确认（对照 confirmCloseSession 偏好） */}
      {pendingClose && (
        <CloseDocumentsDialog
          documents={hosts
            .filter((h) => pendingClose.ids.includes(h.id))
            .flatMap((h) =>
              h.files
                .filter((f) => f.text !== f.saved || f.saving)
                .map((f) => ({ hostId: h.id, fileId: f.id, name: `${h.title}: ${f.path}` }))
            )}
          message={t(
            pendingClose.quit ? 'session.closeSessionMessage' : 'session.closeUserConnections'
          )}
          hostIds={pendingClose.quit ? undefined : pendingClose.ids}
          onCancel={() => setPendingClose(null)}
          onClose={(agentConnectionIds) => {
            pendingClose.ids.forEach((id) => closeHost(id, agentConnectionIds))
            if (pendingClose.quit) window.aterm.window.confirmClose()
            setPendingClose(null)
          }}
        />
      )}

      {/* Toast：底部黑色胶囊，1.4s 自动淡出 */}
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center transition-all duration-200',
          toast ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
        )}
      >
        {toast && (
          <span
            className={cn(
              'glass rounded-full px-3 py-[7px] text-minor font-medium',
              toast.danger ? 'border border-danger/60 text-danger' : 'text-fg'
            )}
          >
            {toast.text}
          </span>
        )}
      </div>
      <LogDrawer />
    </div>
  )
}

export default App
