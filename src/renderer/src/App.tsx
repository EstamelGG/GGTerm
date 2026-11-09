import { ActivityRail } from '@/components/activity/ActivityRail'
import { WorkspaceIssues } from '@/components/chrome/WorkspaceIssues'
import { CloseDocumentsDialog } from '@/components/editor/CloseDocumentsDialog'
import { LogDrawer } from '@/components/logs/LogDrawer'
import { cn } from '@/lib/utils'
import { BrowserPage } from '@/pages/BrowserPage'
import ConnectionPage from '@/pages/ConnectionPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { useExecutionTabs } from '@/stores/executionTabs'
import { useLocalTerminalStore } from '@/stores/localTerminal'
import { usePrefsStore } from '@/stores/prefs'
import { useSessionStore } from '@/stores/session'
import { errorMessage } from '@shared/error'
import type { HostConnection } from '@shared/types'
import { Suspense, lazy, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppHeader } from './app/AppHeader'
import { useAppRuntime } from './app/useAppRuntime'
import { useToast } from './app/useToast'
import { useWorkspaceClose } from './app/useWorkspaceClose'

/** 终端页/主机页 lazy 分包：xterm、monaco 等重依赖移出首包（页面加载后实例照常常驻） */

const LocalTerminalPage = lazy(() =>
  import('./pages/LocalTerminalPage').then((m) => ({ default: m.LocalTerminalPage }))
)
const HostSessionPage = lazy(() =>
  import('./pages/HostSessionPage').then((m) => ({ default: m.HostSessionPage }))
)

/** 单行工作区 / 主机导航，下方主区域切换（页面常驻保实例）。 */
function App(): React.JSX.Element {
  const { toast, setToast, flash } = useToast()
  useAppRuntime(flash)
  const { pendingClose, setPendingClose, affectedForwardCount, requestClose } = useWorkspaceClose()
  const prefs = usePrefsStore((s) => s.data)
  const { t } = useTranslation()
  const tab = useSessionStore((s) => s.tab)
  const hosts = useSessionStore((s) => s.hosts)
  const setTab = useSessionStore((s) => s.setTab)
  const closeHost = useSessionStore((s) => s.closeHost)
  const connect = useSessionStore((s) => s.connect)
  const [browserHasContent, setBrowserHasContent] = useState(false)
  const [localOpened, setLocalOpened] = useState(false)
  const openHost = (id: string): void => {
    const state = useSessionStore.getState()
    const host = state.hosts.find((host) => host.id === id)
    if (
      host &&
      !host.viewerOnly &&
      host.shells.length === 0 &&
      !useExecutionTabs.getState().tasks.some((task) => task.hostId === id)
    )
      state.addShell(id)
    setTab({ kind: 'host', id })
  }

  const handleConnect = (c: HostConnection): void => {
    void connect(c).catch((err) => flash(errorMessage(err), true))
  }

  return (
    <div className="relative flex h-full flex-col bg-bg">
      {/* 单行导航：工作区入口固定，主机标签横滚，设置固定在右端。 */}
      <AppHeader
        browserHasContent={browserHasContent}
        onOpenLocal={() => setLocalOpened(true)}
        openHost={openHost}
        requestClose={requestClose}
      />

      <main className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1">
          <ConnectionPage
            active={tab.kind === 'connections'}
            perfEnabled={!(prefs?.perfMonitorDisabled ?? false)}
            onToast={flash}
            onConnect={handleConnect}
          >
            <BrowserPage
              active={tab.kind === 'browser'}
              onHasContentChange={setBrowserHasContent}
              obscured={pendingClose !== null}
              onToast={flash}
              notification={toast}
              onDismissNotification={() => setToast(null)}
            />
            <Suspense fallback={null}>
              {localOpened && <LocalTerminalPage active={tab.kind === 'local'} onToast={flash} />}
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
        <ActivityRail />
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
          message={[
            t(pendingClose.quit ? 'session.closeSessionMessage' : 'session.closeUserConnections'),
            pendingClose.quit &&
            useLocalTerminalStore.getState().tabs.some((tab) => tab.exitCode === undefined)
              ? t('localTerminal.closeMessage')
              : '',
            affectedForwardCount ? t('forward.disconnectHint', { count: affectedForwardCount }) : ''
          ]
            .filter(Boolean)
            .join('\n')}
          hostIds={pendingClose.quit ? undefined : pendingClose.ids}
          onCancel={() => setPendingClose(null)}
          onClose={(agentConnectionIds) => {
            pendingClose.ids.forEach((id) => closeHost(id, agentConnectionIds))
            if (pendingClose.quit) window.aterm.window.confirmClose()
            setPendingClose(null)
          }}
        />
      )}

      <div className="absolute inset-x-3 top-12 z-40">
        <WorkspaceIssues />
      </div>

      {/* Toast：底部胶囊，4s 自动淡出 */}
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center transition-all duration-200',
          toast ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
        )}
      >
        {toast && tab.kind !== 'browser' && (
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
