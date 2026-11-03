import { CloseTabsMenu } from '@/components/chrome/CloseTabsMenu'
import { OverflowTabs } from '@/components/chrome/OverflowTabs'
import { TabChip } from '@/components/chrome/TabChip'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { IconButton } from '@/components/ui/IconButton'
import { linkStateDot } from '@/lib/linkPhase'
import { hexToCss } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { isBusy, pendingApprovals, useAiStore } from '@/stores/ai'
import { useConnectionsStore } from '@/stores/connections'
import { useHumanInputStore } from '@/stores/humanInput'
import { useLinksStore } from '@/stores/links'
import { useLogStore } from '@/stores/logs'
import { useQuestionsStore } from '@/stores/questions'
import { isTab, useSessionStore } from '@/stores/session'
import { useWorkspaceStore } from '@/stores/workspace'
import {
  Globe,
  LayoutGrid,
  PanelRightClose,
  PanelRightOpen,
  ScrollText,
  Settings,
  TerminalSquare,
  Waypoints
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

export function AppHeader({
  browserHasContent,
  onOpenLocal,
  openHost,
  requestClose
}: {
  browserHasContent: boolean
  onOpenLocal: () => void
  openHost: (id: string) => void
  requestClose: (ids: string[], quit?: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tab = useSessionStore((s) => s.tab)
  const hosts = useSessionStore((s) => s.hosts)
  const setTab = useSessionStore((s) => s.setTab)
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
  const aiNeedsQuestion = useQuestionsStore((s) => Object.keys(s.pending).length > 0)
  const aiNeedsInput = useHumanInputStore((s) => Object.keys(s.pending).length > 0)
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen)
  const setSidebarOpen = useWorkspaceStore((s) => s.setSidebarOpen)
  /** 日志面板开关态：非 macOS 用顶部按钮呼出（那里没有常驻菜单栏） */
  const logOpen = useLogStore((s) => s.open)

  return (
    <header
      className={cn(
        'drag flex h-10 shrink-0 items-center border-b border-chrome-sep bg-chrome-bar pr-3',
        window.aterm.window.platform === 'darwin' ? 'pl-[78px]' : 'pl-3'
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5">
        <IconButton
          variant="toolbar"
          title={t('session.tabConnections')}
          icon={LayoutGrid}
          selected={tab.kind === 'connections'}
          aria-pressed={tab.kind === 'connections'}
          onClick={() => setTab({ kind: 'connections' })}
        />
        <IconButton
          variant="toolbar"
          title={t('session.tabTopology')}
          icon={Waypoints}
          selected={tab.kind === 'ai'}
          aria-pressed={tab.kind === 'ai'}
          onClick={() => setTab({ kind: 'ai' })}
        />
        <IconButton
          variant="toolbar"
          title={t('localTerminal.tab')}
          icon={TerminalSquare}
          selected={tab.kind === 'local'}
          aria-pressed={tab.kind === 'local'}
          onClick={() => {
            onOpenLocal()
            setTab({ kind: 'local' })
          }}
        />
        <div
          className={cn(
            'rounded-md transition-shadow duration-200',
            browserHasContent &&
              'ring-1 ring-at-accent/70 ring-offset-2 ring-offset-chrome-bar shadow-[0_0_10px_rgb(var(--at-accent-rgb)/0.35)]'
          )}
        >
          <IconButton
            variant="toolbar"
            title={t('browser.tab')}
            icon={Globe}
            selected={tab.kind === 'browser'}
            aria-pressed={tab.kind === 'browser'}
            onClick={() => setTab({ kind: 'browser' })}
          />
        </div>
      </div>
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
          icon={sidebarOpen ? PanelRightClose : PanelRightOpen}
          title={t(sidebarOpen ? 'activity.hideSidebar' : 'activity.showSidebar')}
          aria-expanded={sidebarOpen}
          selected={sidebarOpen}
          onClick={() => setSidebarOpen(!sidebarOpen)}
        />
        {(aiBusy || aiNeedsAttention || aiNeedsInput || aiNeedsQuestion) && (
          <span
            className={cn(
              'pointer-events-none absolute right-0 top-0 h-1.5 w-1.5 rounded-full',
              aiNeedsAttention || aiNeedsInput || aiNeedsQuestion ? 'bg-danger' : 'bg-at-accent'
            )}
          />
        )}
      </div>
    </header>
  )
}
