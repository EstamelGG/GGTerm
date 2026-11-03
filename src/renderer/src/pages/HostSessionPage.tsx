import { ExecutionOutput } from '@/components/ai/ExecutionOutput'
import { CHROME_ROW } from '@/components/chrome/layout'
import { SessionTabs } from '@/components/chrome/SessionTabs'
import { Button } from '@/components/form/Buttons'
import { SftpPane } from '@/components/sftp/SftpPane'
import { IconButton } from '@/components/ui/IconButton'
import { shellStateDot } from '@/lib/linkPhase'
import { cn } from '@/lib/utils'
import { useExecutionTabs } from '@/stores/executionTabs'
import { useSessionStore, type HostWorkspaceMirror } from '@/stores/session'
import { isNetworkDevice } from '@shared/device'
import type { ExecutionSnapshot } from '@shared/execution'
import { shellQuote } from '@shared/sftpPath'
import type { ShellStatus } from '@shared/types'
import { PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LinkStatusPill, ShellPane } from './host/HostConnectionStatus'
import { HostFilesPane } from './host/HostFilesPane'
import { ManualAuthDialog } from './host/ManualAuthDialog'
import { useHostLayout } from './host/useHostLayout'

import { DialogShell } from '@/components/ui/DialogShell'

function shouldShowReconnect(s: ShellStatus): boolean {
  return s === 'disconnected' || s === 'ended' || s === 'error'
}

/** 对照 HostSessionPage.swift：SFTP 分栏 + splitter + chrome + workspace */
export function HostSessionPage({
  host,
  onToast,
  onClose
}: {
  host: HostWorkspaceMirror
  onToast: (text: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const agentTasks = useExecutionTabs((s) => s.tasks).filter((task) => task.hostId === host.id)
  const activeAgent =
    agentTasks.find((task) => task.executionId === host.focusShellId) ??
    (host.shells.length === 0 ? agentTasks[0] : undefined)
  const [pendingAgents, setPendingAgents] = useState<ExecutionSnapshot[]>([])
  const pendingAgent = pendingAgents[0]
  const [closingAgent, setClosingAgent] = useState(false)
  const networkDevice = isNetworkDevice(host.conn)
  const canSftp = !networkDevice && host.shells.length > 0
  const {
    rootRef,
    sftpOverlay,
    sftpVisible,
    toggleSftp,
    effectiveWidth,
    widthResize,
    dragging,
    previewWidth,
    widthPreviewRef,
    workspaceRef,
    previewH,
    heightPreviewRef,
    editorH,
    maxEditorH,
    heightResize
  } = useHostLayout(canSftp)

  const addShell = useSessionStore((s) => s.addShell)
  const closeShell = useSessionStore((s) => s.closeShell)
  const focusShell = useSessionStore((s) => s.focusShell)
  const openFile = useSessionStore((s) => s.openFile)
  const reconnectHost = useSessionStore((s) => s.reconnectHost)
  const reconnectShell = useSessionStore((s) => s.reconnectShell)

  const focused = activeAgent
    ? undefined
    : (host.shells.find((s) => s.id === host.focusShellId) ?? host.shells[0])
  /** 链路级重连：offline（重试超限）与 idle（被主动断开，含 AI 断开）都需要；点重连后原会话自动恢复 */
  const showLinkReconnect =
    !host.viewerOnly &&
    !activeAgent &&
    (host.phase === 'offline' || host.phase === 'idle') &&
    !host.awaiting
  const showShellReconnect =
    !showLinkReconnect &&
    focused !== undefined &&
    shouldShowReconnect(focused.status) &&
    host.phase === 'connected'

  return (
    <div ref={rootRef} className="relative flex h-full bg-sidebar">
      {sftpOverlay && sftpVisible && (
        <button
          className="absolute inset-0 z-20 bg-black/20"
          aria-label={t('sftp.collapsePane')}
          onClick={toggleSftp}
        />
      )}
      {/* 左：SFTP 面板（对照 SftpPane(host:)）。收纳开关在下方控制台标签行行首（常驻不随标签滚动）。
          收纳时外层宽度归 0 + overflow-hidden，内层仍按原宽排版 ——
          测量尺寸不变，展开时树不重测、滚动位置与选中态都保留 */}
      <div
        className={cn(
          'h-full shrink-0 overflow-hidden bg-sidebar',
          sftpVisible && 'border-r border-line',
          sftpOverlay && 'absolute inset-y-0 left-0 z-30'
        )}
        style={{ width: sftpVisible ? effectiveWidth : 0 }}
        aria-hidden={!sftpVisible}
        inert={!sftpVisible}
      >
        <div className="h-full" style={{ width: effectiveWidth }}>
          {canSftp && (
            <SftpPane
              hostId={host.id}
              onToast={onToast}
              onOpenTerminal={(dir) => addShell(host.id, `cd ${shellQuote(dir)}`)}
              onOpenFile={(entry) => openFile(host.id, entry)}
            />
          )}
        </div>
      </div>

      {sftpVisible && !sftpOverlay && (
        <>
          {/* splitter：1px，拖拽中 accent 35% + 预览线 */}
          <div
            className={cn(
              'relative z-10 w-px shrink-0 cursor-col-resize touch-none',
              dragging ? 'bg-at-accent/35' : 'bg-line'
            )}
          >
            <div
              className="absolute inset-y-0 -left-1 w-2.5 cursor-col-resize touch-none"
              {...widthResize.handleProps}
            />
          </div>
          {dragging && previewWidth !== null && (
            <div
              ref={widthPreviewRef}
              className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-at-accent/85"
              style={{ left: effectiveWidth - 1 }}
            />
          )}
        </>
      )}

      {/* 右：上下分栏 —— 上=文件编辑区、下=SSH 会话区（两区焦点独立、各自滚动） */}
      <div ref={workspaceRef} className="relative flex min-w-0 flex-1 flex-col">
        {previewH !== null && (
          <div
            ref={heightPreviewRef}
            className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-at-accent/85"
            style={{ top: previewH + 40 }}
          />
        )}
        {/* 上：文件编辑区（无打开文件时整体隐藏，终端占满全高）。
            高度参与方式：未拖过高度时与终端区 flex 均分——grow 1↔0 + grid-rows 0↔1fr 双过渡，
            展开/收起均有动画（RevealRow 自带的 transition 只覆盖 grid-rows，这里覆写补上 flex-grow）；
            拖拽定高后（editorH/previewH 非空）改内容定高，收起时 0fr 行高随内容塌陷动画同样成立 */}
        <HostFilesPane
          host={host}
          editorH={editorH}
          maxEditorH={maxEditorH}
          previewH={previewH}
          heightResize={heightResize}
        />

        {/* 下：SSH 会话区（常驻）。chips 在滚动区内横滚，'+' 与状态胶囊固定行尾不越界 */}
        <div className={cn(CHROME_ROW, 'bg-sidebar')}>
          {/* SFTP 面板收纳开关：固定在标签行行首，不随 chips 横滚 */}
          <IconButton
            variant="toolbar"
            disabled={!canSftp}
            icon={sftpVisible ? PanelLeftClose : PanelLeftOpen}
            frame={22}
            title={sftpVisible ? t('sftp.collapsePane') : t('sftp.expandPane')}
            aria-expanded={sftpVisible}
            onClick={toggleSftp}
          />
          <SessionTabs
            tabs={[
              ...host.shells.map((s) => ({
                id: s.id,
                title: t('session.consoleTitle', { n: s.number }),
                statusColor: shellStateDot(s.status)
              })),
              ...agentTasks.map((task) => ({
                id: task.executionId,
                title: `agent ${task.sessionId.slice(0, 6)} · ${task.executionId.slice(0, 6)}`,
                statusColor: shellStateDot(
                  task.status === 'running'
                    ? 'connected'
                    : task.status === 'starting'
                      ? 'connecting'
                      : 'ended'
                )
              }))
            ]}
            selectedId={activeAgent?.executionId ?? focused?.id ?? null}
            onSelect={(id) => focusShell(host.id, id)}
            onClose={(id) => {
              const task = agentTasks.find((task) => task.executionId === id)
              if (task)
                setPendingAgents((items) =>
                  items.some((item) => item.executionId === task.executionId)
                    ? items
                    : [...items, task]
                )
              else closeShell(host.id, id)
            }}
          />
          <IconButton
            variant="toolbar"
            icon={Plus}
            size={10}
            frame={22}
            cornerRadius={11}
            filled
            aria-label={t('session.newTerminal')}
            onClick={() => {
              void useSessionStore
                .getState()
                .connect(host.conn)
                .catch((e) => onToast(String(e)))
            }}
          />
          <span className="text-caption text-muted">
            {activeAgent ? (
              `agent · ${t(`execution.${activeAgent.status}`)}`
            ) : (
              <LinkStatusPill host={host} />
            )}
          </span>
          {(showLinkReconnect || showShellReconnect) && (
            <Button
              variant="ghost"
              title={t('session.reconnect')}
              className="animate-in fade-in duration-150"
              onClick={() => {
                if (showLinkReconnect) reconnectHost(host.id)
                else if (focused) reconnectShell(host.id, focused.id)
              }}
            />
          )}
        </div>

        <div className="relative min-h-0 flex-1 bg-sidebar">
          {!activeAgent && host.phase === 'offline' && host.offlineReason && (
            <p
              role="alert"
              className="absolute inset-x-0 top-0 z-20 max-h-full overflow-auto whitespace-pre-wrap break-words bg-sidebar px-3 py-2 text-minor text-danger select-text"
            >
              {host.offlineReason}
            </p>
          )}
          {host.shells.map((s) => (
            <ShellPane key={s.id} host={host} shell={s} focused={focused?.id === s.id} />
          ))}
          {activeAgent && (
            <div className="absolute inset-0 flex flex-col gap-2 p-2">
              <p className="text-caption text-muted">{t('execution.readOnly')}</p>
              {activeAgent.error && (
                <p role="alert" className="text-minor text-danger">
                  {activeAgent.error}
                </p>
              )}
              <div className="min-h-0 flex-1">
                <ExecutionOutput key={activeAgent.executionId} task={activeAgent} />
              </div>
            </div>
          )}
          {host.shells.length === 0 && !activeAgent && (
            <div className="flex h-full items-center justify-center">
              <p className="text-body text-muted">{t('session.noSessions')}</p>
            </div>
          )}
        </div>
      </div>

      {pendingAgent && (
        <DialogShell
          open
          title={t('execution.closeTab')}
          dismissable={!closingAgent}
          onOpenChange={(open) => {
            if (!open && !closingAgent) setPendingAgents([])
          }}
          footer={
            <>
              <Button
                variant="ghost"
                title={t('common.cancel')}
                disabled={closingAgent}
                onClick={() => setPendingAgents([])}
              />
              <Button
                variant="danger"
                title={t('common.close')}
                disabled={closingAgent}
                onClick={() => {
                  setClosingAgent(true)
                  void useExecutionTabs
                    .getState()
                    .close(pendingAgent)
                    .then(() => setPendingAgents((items) => items.slice(1)))
                    .catch((e) => onToast(String(e)))
                    .finally(() => setClosingAgent(false))
                }}
              />
            </>
          }
        >
          <p className="text-body text-fg">{t('execution.closeTabConfirm')}</p>
        </DialogShell>
      )}
      <ManualAuthDialog host={host} onClose={onClose} />
    </div>
  )
}
