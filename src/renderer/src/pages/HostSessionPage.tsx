import { isNetworkDevice } from '@shared/device'
import { useExecutionTabs } from '@/stores/executionTabs'
import { ExecutionOutput } from '@/components/ai/ExecutionOutput'
import type { ExecutionSnapshot } from '@shared/execution'
import { useResizePreview } from '@/lib/useResizePreview'
import { SessionTabs } from '@/components/chrome/SessionTabs'
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react'
import type { LinkPhase, ShellStatus } from '@shared/types'
import { linkStateColor, shellStateDot } from '@/lib/linkPhase'
import { shellQuote } from '@shared/sftpPath'
import { cn } from '@/lib/utils'
import { observeSettledResize } from '@/lib/observeSettledResize'
import { useSessionStore, type HostWorkspaceMirror, type RemoteFileDoc } from '@/stores/session'
import { Button, ATField } from '@/components/form/Buttons'
import { ATTextField, CheckBox } from '@/components/form/Fields'
import { SecretEditor, SecretField } from '@/components/form/Secrets'
import { ChoiceChip } from '@/components/ui/ChoiceChip'
import { IconButton } from '@/components/ui/IconButton'
import { CHROME_ROW } from '@/components/chrome/layout'
import { RevealRow } from '@/components/chrome/RevealRow'
import { TabChip, TabScrollArea } from '@/components/chrome/TabChip'
import { TerminalPane } from '@/components/terminal/TerminalPane'
import { WorkspacePane } from '@/components/terminal/WorkspacePane'
import { SftpPane } from '@/components/sftp/SftpPane'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** monaco 核心 ~4MB：首个文件标签页出现时才加载（之后常驻，实例不销毁） */
const RemoteEditorView = lazy(() =>
  import('@/components/editor/RemoteEditorView').then((m) => ({ default: m.RemoteEditorView }))
)
import { DialogShell } from '@/components/ui/DialogShell'
import { CloseDocumentsDialog } from '@/components/editor/CloseDocumentsDialog'

const WIDTH_KEY = 'ggterm.sftpWidth'
const MIN_WIDTH = 240
const MAX_WIDTH = 520

function loadWidth(): number {
  const raw = localStorage.getItem(WIDTH_KEY)
  const v = raw === null ? NaN : Number(raw)
  return Number.isFinite(v) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v)) : 300
}

/** 左栏收纳状态（'0' 收起 / 其它展开）：与宽度同存 localStorage，跨会话沿用 */
const OPEN_KEY = 'ggterm.sftpOpen'

function loadSftpOpen(): boolean {
  return localStorage.getItem(OPEN_KEY) !== '0'
}

/** 上部文件编辑区高度（px）：null = 未拖过，与终端区 flex 均分（默认 50/50） */
const EDITOR_H_KEY = 'ggterm.sessionEditorH'
const EDITOR_H_MIN = 140
/** 下区最小高度（标签栏 + 可用终端视口） */
const SHELL_H_MIN = 160

function loadEditorH(): number | null {
  const raw = localStorage.getItem(EDITOR_H_KEY)
  const v = raw === null ? NaN : Number(raw)
  return Number.isFinite(v) && v >= EDITOR_H_MIN ? v : null
}

function shouldShowReconnect(s: ShellStatus): boolean {
  return s === 'disconnected' || s === 'ended' || s === 'error'
}

/** 链路状态 → i18n key（渲染处 t() 插值，保证切语言实时生效） */
function phaseLabelKey(
  phase: LinkPhase
):
  | 'session.statusConnected'
  | 'session.statusReconnecting'
  | 'session.statusDisconnected'
  | 'session.statusConnecting' {
  switch (phase) {
    case 'connected':
      return 'session.statusConnected'
    case 'reconnecting':
      return 'session.statusReconnecting'
    // offline = 重试超限失败；idle = 链路被断开（含 AI 主动断开，可重连恢复）
    case 'offline':
    case 'idle':
      return 'session.statusDisconnected'
    default:
      return 'session.statusConnecting'
  }
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
  const [width, setWidth] = useState(() => loadWidth())
  /** 左栏收纳：面板保持挂载（树/选中/滚动不丢），只把宽度归零 */
  const [sftpOpen, setSftpOpen] = useState(loadSftpOpen)
  const toggleSftp = (): void => {
    const next = !sftpOpen
    localStorage.setItem(OPEN_KEY, next ? '1' : '0')
    setSftpOpen(next)
  }
  const rootRef = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState({ width: 980, height: 540 })
  const widthPreviewRef = useRef<HTMLDivElement>(null)
  // 上部编辑区高度（竖向 splitter；null = 均分）
  const [editorH, setEditorH] = useState<number | null>(() => loadEditorH())
  const heightPreviewRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    return observeSettledResize(root, () =>
      setBounds({ width: root.clientWidth, height: root.clientHeight })
    )
  }, [])
  const maxSftpWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, bounds.width - 361))
  const effectiveWidth = Math.min(width, maxSftpWidth)
  // Reserve both tab rows and the divider in addition to the terminal viewport.
  const maxEditorH = Math.max(EDITOR_H_MIN, bounds.height - SHELL_H_MIN - 81)
  const [authUser, setAuthUser] = useState(host.conn.username)
  const [authPassword, setAuthPassword] = useState('')
  const [authMode, setAuthMode] = useState<'password' | 'privateKey'>('password')
  const [authKey, setAuthKey] = useState('')
  const [authPassphrase, setAuthPassphrase] = useState('')
  const [savePwd, setSavePwd] = useState(false)
  const [pendingCloseFile, setPendingCloseFile] = useState<RemoteFileDoc | null>(null)

  const addShell = useSessionStore((s) => s.addShell)
  const closeShell = useSessionStore((s) => s.closeShell)
  const focusShell = useSessionStore((s) => s.focusShell)
  const openFile = useSessionStore((s) => s.openFile)
  const saveFile = useSessionStore((s) => s.saveFile)
  const reloadFile = useSessionStore((s) => s.reloadFile)
  const closeFile = useSessionStore((s) => s.closeFile)
  const focusFile = useSessionStore((s) => s.focusFile)
  const setFileText = useSessionStore((s) => s.setFileText)
  const reconnectHost = useSessionStore((s) => s.reconnectHost)
  const reconnectShell = useSessionStore((s) => s.reconnectShell)
  const submitAuth = useSessionStore((s) => s.submitAuth)

  const focused = activeAgent
    ? undefined
    : (host.shells.find((s) => s.id === host.focusShellId) ?? host.shells[0])
  /** 上区显示的文件（focusFileId 兜底到最后一个，保证编辑区总有可见内容） */
  const activeFileId = host.focusFileId ?? host.files[host.files.length - 1]?.id ?? null
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

  const widthResize = useResizePreview({
    value: effectiveWidth,
    min: MIN_WIDTH,
    max: maxSftpWidth,
    onCommit: (next) => {
      setWidth(next)
      localStorage.setItem(WIDTH_KEY, String(next))
    },
    onPreview: (next) => {
      if (widthPreviewRef.current) widthPreviewRef.current.style.left = `${next - 1}px`
    }
  })
  const heightResize = useResizePreview({
    value: Math.min(editorH ?? Math.round(Math.max(0, bounds.height - 81) / 2), maxEditorH),
    min: EDITOR_H_MIN,
    max: maxEditorH,
    axis: 'y',
    onCommit: (next) => {
      setEditorH(next)
      localStorage.setItem(EDITOR_H_KEY, String(next))
    },
    onPreview: (next) => {
      if (heightPreviewRef.current) heightPreviewRef.current.style.top = `${next + 40}px`
    }
  })
  const previewWidth = widthResize.preview
  const previewH = heightResize.preview
  const dragging = previewWidth !== null

  const canSubmitAuth =
    authUser.trim() !== '' &&
    (authMode === 'password' ? authPassword !== '' : authKey.trim() !== '')

  return (
    <div ref={rootRef} className="relative flex h-full bg-sidebar">
      {/* 左：SFTP 面板（对照 SftpPane(host:)）。收纳开关在下方控制台标签行行首（常驻不随标签滚动）。
          收纳时外层宽度归 0 + overflow-hidden，内层仍按原宽排版 ——
          测量尺寸不变，展开时树不重测、滚动位置与选中态都保留 */}
      <div
        className={cn(
          'h-full shrink-0 overflow-hidden bg-sidebar',
          canSftp && sftpOpen && 'border-r border-line'
        )}
        style={{ width: canSftp && sftpOpen ? effectiveWidth : 0 }}
        aria-hidden={!canSftp || !sftpOpen}
        inert={!canSftp || !sftpOpen}
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

      {canSftp && sftpOpen && (
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
        <RevealRow
          open={host.files.length > 0}
          className={
            editorH === null
              ? cn(
                  'min-h-0 basis-0 transition-[flex-grow,grid-template-rows] duration-200 ease-out',
                  host.files.length > 0 ? 'grow' : 'grow-0'
                )
              : undefined
          }
        >
          <>
            {/* 文件标签行：chips 横滚限位（无行尾按钮，整行即滚动区） */}
            <div className={CHROME_ROW}>
              <TabScrollArea>
                {host.files.map((f) => (
                  <TabChip
                    key={f.id}
                    title={f.text !== f.saved ? `${f.name} •` : f.name}
                    icon={FileText}
                    selected={activeFileId === f.id}
                    accentBorder={f.text !== f.saved}
                    showClose
                    onClick={() => focusFile(host.id, f.id)}
                    onClose={() => {
                      if (f.text !== f.saved || f.saving) setPendingCloseFile(f)
                      else closeFile(host.id, f.id)
                    }}
                  />
                ))}
              </TabScrollArea>
            </div>
            <div
              className={cn(
                'relative min-h-0 bg-sidebar',
                editorH === null ? 'flex-1' : 'shrink-0'
              )}
              style={editorH !== null ? { height: Math.min(editorH, maxEditorH) } : undefined}
            >
              {host.files.map((f) => (
                <div
                  key={f.id}
                  className={cn(
                    'absolute inset-0',
                    activeFileId === f.id ? 'z-10' : 'pointer-events-none opacity-0'
                  )}
                >
                  <Suspense fallback={null}>
                    <RemoteEditorView
                      doc={f}
                      onText={(text) => setFileText(host.id, f.id, text)}
                      onSave={() => saveFile(host.id, f.id)}
                      onReload={() => reloadFile(host.id, f.id)}
                      onEncoding={(encoding) => reloadFile(host.id, f.id, encoding)}
                      onDownload={() =>
                        window.aterm.sftp.download(host.id, {
                          name: f.name,
                          path: f.path,
                          isDir: false,
                          isLink: false,
                          size: f.size,
                          permissions: null,
                          uid: null,
                          gid: null,
                          accessed: null,
                          modified: null,
                          longname: '',
                          linkTarget: null
                        })
                      }
                    />
                  </Suspense>
                </div>
              ))}
            </div>
            {/* 竖向 splitter：拖拽调编辑区高度（松手持久化；拖拽中 accent 提示） */}
            <div
              className={cn(
                'h-px shrink-0 cursor-row-resize touch-none',
                previewH !== null ? 'bg-at-accent/35' : 'bg-line'
              )}
              {...heightResize.handleProps}
            />
          </>
        </RevealRow>

        {/* 下：SSH 会话区（常驻）。chips 在滚动区内横滚，'+' 与状态胶囊固定行尾不越界 */}
        <div className={CHROME_ROW}>
          {/* SFTP 面板收纳开关：固定在标签行行首，不随 chips 横滚 */}
          <IconButton
            variant="toolbar"
            disabled={!canSftp}
            icon={sftpOpen ? PanelLeftClose : PanelLeftOpen}
            frame={22}
            title={sftpOpen ? t('sftp.collapsePane') : t('sftp.expandPane')}
            aria-expanded={sftpOpen}
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
      {/* 关闭未保存文件确认 */}
      {pendingCloseFile && (
        <CloseDocumentsDialog
          documents={[
            { hostId: host.id, fileId: pendingCloseFile.id, name: pendingCloseFile.path }
          ]}
          message={t('session.closeFileMessage', { name: pendingCloseFile.name })}
          onCancel={() => setPendingCloseFile(null)}
          onClose={() => {
            closeFile(host.id, pendingCloseFile.id)
            setPendingCloseFile(null)
          }}
        />
      )}

      {/* 手动认证模态（阻断型：遮罩/Esc/X 均不可关，必须提交） */}
      <DialogShell
        open={host.awaiting}
        onOpenChange={(open) => !open && onClose()}
        preventAutoFocus
        title={t('session.manualLoginTitle')}
        width={360}
        footer={
          <>
            <Button variant="ghost" title={t('common.cancel')} onClick={onClose} />
            <Button
              title={t('common.connect')}
              disabled={!canSubmitAuth}
              onClick={() => {
                submitAuth(host.id, {
                  username: authUser,
                  password: authMode === 'password' ? authPassword : undefined,
                  privateKey: authMode === 'privateKey' ? authKey : undefined,
                  passphrase: authMode === 'privateKey' ? authPassphrase : undefined,
                  persist: savePwd
                })
                setAuthPassword('')
                setAuthKey('')
                setAuthPassphrase('')
                setSavePwd(false)
              }}
            />
          </>
        }
      >
        <p className="font-mono text-caption text-muted">
          {host.conn.host}:{host.conn.port}
        </p>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex gap-2">
            <ChoiceChip
              shape="pill"
              selected={authMode === 'password'}
              onClick={() => setAuthMode('password')}
            >
              {t('conn.form.authPassword')}
            </ChoiceChip>
            <ChoiceChip
              shape="pill"
              selected={authMode === 'privateKey'}
              onClick={() => setAuthMode('privateKey')}
            >
              {t('conn.form.authPrivateKey')}
            </ChoiceChip>
          </div>
          <ATField title={t('session.username')}>
            <ATTextField value={authUser} onChange={setAuthUser} autoFocus />
          </ATField>
          {authMode === 'password' ? (
            <ATField title={t('session.password')}>
              <SecretField value={authPassword} onChange={setAuthPassword} />
            </ATField>
          ) : (
            <>
              <ATField title={t('conn.form.privateKey')}>
                <SecretEditor
                  value={authKey}
                  onChange={setAuthKey}
                  placeholder={t('conn.form.privateKeyPlaceholder')}
                  minHeight={96}
                />
              </ATField>
              <ATField title={t('conn.form.passphrase')}>
                <SecretField value={authPassphrase} onChange={setAuthPassphrase} />
              </ATField>
            </>
          )}
          <div className="flex items-center">
            <button
              type="button"
              className="flex cursor-pointer items-center gap-1.5 rounded-sm outline-none focus-visible:ring-[1.5px] focus-visible:ring-at-accent/70"
              onClick={() => setSavePwd((v) => !v)}
            >
              <CheckBox state={savePwd ? 'on' : 'off'} />
              <span className="text-minor text-muted">
                {t(authMode === 'password' ? 'session.savePassword' : 'session.saveKey')}
              </span>
            </button>
          </div>
        </div>
      </DialogShell>
    </div>
  )
}

function ShellPane({
  host,
  shell,
  focused
}: {
  host: HostWorkspaceMirror
  shell: { id: string; number: number; status: ShellStatus; error?: string }
  focused: boolean
}): React.JSX.Element {
  return (
    <div className={cn('absolute inset-0', focused ? '' : 'pointer-events-none opacity-0')}>
      <WorkspacePane
        overlay={
          focused && shell.status === 'error' && shell.error ? (
            <div className="absolute inset-x-0 top-0 flex justify-center pt-5 animate-in fade-in duration-200">
              <span className="glass max-w-[80%] truncate rounded-full px-2.5 py-[5px] text-caption font-medium text-fg">
                {shell.error}
              </span>
            </div>
          ) : undefined
        }
      >
        <TerminalPane instanceKey={`${host.id}:${shell.id}`} />
      </WorkspacePane>
    </div>
  )
}

/** 对照 LinkStatusPill：状态点 + label，点击弹心跳诊断 */
function LinkStatusPill({ host }: { host: HostWorkspaceMirror }): React.JSX.Element {
  const { t } = useTranslation()
  const [hovering, setHovering] = useState(false)
  const [open, setOpen] = useState(false)
  const interval = host.conn.keepaliveInterval

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center gap-[5px] rounded-md border px-2 py-[3px] transition-colors duration-100',
            open
              ? 'border-at-accent/55 bg-at-accent/15'
              : hovering
                ? 'border-line bg-hover/70'
                : 'border-line bg-raised/45',
            open || hovering ? 'text-fg' : 'text-muted'
          )}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
        >
          <span
            className="h-1.5 w-1.5 rounded-full transition-colors duration-300"
            style={{ backgroundColor: linkStateColor(host.phase) }}
          />
          <span
            key={host.phase}
            className="text-caption animate-in fade-in slide-in-from-bottom-1 duration-200"
          >
            {t(phaseLabelKey(host.phase), { attempt: host.attempt, total: 3 })}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-64 border-line p-3.5">
        <div className="flex items-center gap-1.5">
          <span
            className="h-1.5 w-1.5 rounded-full transition-colors duration-300"
            style={{ backgroundColor: linkStateColor(host.phase) }}
          />
          <span
            key={host.phase}
            className="text-minor font-semibold text-fg animate-in fade-in slide-in-from-bottom-1 duration-200"
          >
            {t(phaseLabelKey(host.phase), { attempt: host.attempt, total: 3 })}
          </span>
        </div>
        <div className="mt-2 flex flex-col gap-[5px]">
          <InfoRow
            title={t('session.keepaliveInterval')}
            value={interval > 0 ? `${interval} ms` : t('common.close')}
          />
          <InfoRow title={t('session.lossThreshold')} value={t('session.times', { n: 3 })} />
          {host.phase === 'offline' && host.offlineReason && (
            <InfoRow title={t('session.offlineReason')} value={host.offlineReason} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function InfoRow({ title, value }: { title: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <span className="text-caption text-muted">{title}</span>
      <span className="min-w-0 flex-1 truncate text-right font-mono text-caption text-fg">
        {value}
      </span>
    </div>
  )
}
