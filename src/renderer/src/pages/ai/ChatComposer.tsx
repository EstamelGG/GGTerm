import { useExecutionTabs } from '@/stores/executionTabs'
import { BrowserReferenceChip } from '@/components/ai/BrowserReferenceChip'
import { ContextUsageIndicator } from '@/components/ai/ContextUsageIndicator'
import { ExecutionSessionsButton } from '@/components/ai/ExecutionSessionsButton'
import { FileReferenceChip } from '@/components/ai/FileReferenceChip'
import { IconButton } from '@/components/ui/IconButton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { activeCommandToken, activeMention, SLASH_COMMANDS } from '@/lib/aiInput'
import { linkStateColor } from '@/lib/linkPhase'
import { cn } from '@/lib/utils'
import { pendingApprovals, useAiStore } from '@/stores/ai'
import { useConnectionsStore } from '@/stores/connections'
import { useHumanInputStore } from '@/stores/humanInput'
import { useLinksStore } from '@/stores/links'
import { usePrefsStore } from '@/stores/prefs'
import { useQuestionsStore } from '@/stores/questions'
import { useSessionStore } from '@/stores/session'
import { useWorkspaceStore } from '@/stores/workspace'
import { contextSettingsFor, modelSettingsKey } from '@shared/ai'
import type { AiApprovalLevel } from '@shared/types'
import type { LucideIcon } from 'lucide-react'
import { ArrowUp, Lock, Server, Shield, ShieldAlert, ShieldCheck, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** 输入框高度下限（约 3 行，VS Code 风格大输入区）与上限 */
const COMPOSER_MIN_H = 64
const COMPOSER_MAX_H = 200

/** 审批强度图标（盾牌系，与设置页同语义）：严格=盾+勾（安全）/ 默认=盾 / 宽松=盾+叹号（需警惕）；
 *  颜色沿用 严格=蓝 / 默认=绿 / 宽松=红 */
const APPROVAL_ICONS: Record<AiApprovalLevel, LucideIcon> = {
  strict: ShieldCheck,
  default: Shield,
  relaxed: ShieldAlert
}
const APPROVAL_ICON_CLS: Record<AiApprovalLevel, string> = {
  strict: 'text-info',
  default: 'text-ok',
  relaxed: 'text-danger'
}
const APPROVAL_LEVELS: {
  value: AiApprovalLevel
  labelKey:
    'settings.aiApprovalStrict' | 'settings.aiApprovalDefault' | 'settings.aiApprovalRelaxed'
}[] = [
  { value: 'strict', labelKey: 'settings.aiApprovalStrict' },
  { value: 'default', labelKey: 'settings.aiApprovalDefault' },
  { value: 'relaxed', labelKey: 'settings.aiApprovalRelaxed' }
]
/** 主机/命令弹出菜单最多展示条数 */
const MENU_MAX = 8

/**
 * VS Code 风格大输入区：上方审批档位 + 待批跳转；下方无内边框 textarea + 工具行（模型 / 发送）。
 * 斜杠命令与 @主机补全仍锚在输入区上方；语义展开发生在 stores/ai.send → lib/aiInput.buildPayload.
 */
export function ChatComposer({
  sessionId,
  busy,
  disabled,
  placeholder,
  onSend,
  onCancel,
  onViewApprovals
}: {
  sessionId: string
  busy: boolean
  disabled: boolean
  placeholder: string
  onSend: (text: string) => void
  onCancel: () => void
  /** 滚动到首个待人工审批的工具卡 */
  onViewApprovals: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const conns = useConnectionsStore((s) => s.connections)
  const browserAttachments = useWorkspaceStore((s) => s.browserAttachments[sessionId])
  const fileAttachments = useWorkspaceStore((s) => s.fileAttachments[sessionId])
  const attachments = useWorkspaceStore((s) => s.attachments[sessionId])
  const focusedId = useWorkspaceStore((s) => s.focusedHostId)
  const focusedHost = conns.find((c) => c.id === focusedId)
  const references = conns.filter((c) => attachments?.includes(c.id))
  const phases = useLinksStore((s) => s.byHost)
  const ai = usePrefsStore((s) => s.data?.ai ?? null)
  const updatePrefs = usePrefsStore((s) => s.update)
  const setTab = useSessionStore((s) => s.setTab)
  /** 待审批数：>0 时输入框光圈切黄闪（与工具卡黄框同语义） */
  const pendingCount = useAiStore(
    (s) => pendingApprovals(s.sessions.find((x) => x.id === sessionId)?.messages ?? []).length
  )
  /** 本会话挂起的人工输入待办（密码/验证码）：同样需要人来处理，故与待审批合并计入 */
  const pendingInputCount = useHumanInputStore(
    (s) => Object.values(s.pending).filter((r) => r.sessionId === sessionId).length
  )
  /** 需要人处理的挂起项总数：驱动跳转胶囊与输入区黄闪光圈 */
  const pendingQuestionCount = useQuestionsStore(
    (s) => Object.values(s.pending).filter((r) => r.sessionId === sessionId).length
  )
  const humanPending = pendingCount + pendingInputCount + pendingQuestionCount
  /** 会话内是否仍有 running 执行：对话 turn 已结束但后台命令还在跑时，光圈保持彩虹 */
  const hasRunningExec = useExecutionTabs((s) =>
    s.tasks.some(
      (task) =>
        task.sessionId === sessionId && (task.status === 'starting' || task.status === 'running')
    )
  )
  /** 对话场景当前绑定（下拉选中值） */
  const chatBinding = ai?.scenarios.chat ?? null
  const contextUsage = useAiStore((s) => s.sessions.find((x) => x.id === sessionId)?.contextUsage)
  const recovery = useAiStore((s) => s.sessions.find((x) => x.id === sessionId)?.recovery)
  /** 可选对话模型 = 供应商 × 已缓存模型列表（缓存来自设置页自动拉取） */
  const chatOptions = (ai?.providers ?? []).flatMap((p) =>
    (ai?.modelCache?.[p.id] ?? []).map((model) => ({ providerId: p.id, label: p.label, model }))
  )

  const [text, setText] = useState('')
  /** 'cmd' | 'mention' | null：当前打开的弹出层（模型选择已改为 Select 下拉） */
  const [menu, setMenu] = useState<'cmd' | 'mention' | null>(null)
  const [menuIdx, setMenuIdx] = useState(0)
  /** 宽松模式确认条：与设置页同语义，确认后才真正放宽审批 */
  const [relaxedConfirm, setRelaxedConfirm] = useState(false)
  /** 当前菜单的过滤词（命令 token 或 @ 后已输入部分；由 recomputeMenu 写入，渲染只读 state） */
  const [menuQuery, setMenuQuery] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const caretRef = useRef(0)

  /* auto-grow：高度随内容增长（下限 3 行），封顶后内部滚动 */
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, COMPOSER_MIN_H), COMPOSER_MAX_H)}px`
  }, [text])

  /* 新建或切换会话（sessionId 变化）后自动聚焦输入框，落位即可输入 */
  useEffect(() => {
    taRef.current?.focus()
  }, [sessionId])

  /** 光标/内容变化后重算菜单开闭与过滤词（命令形态仅限整条输入即命令本身） */
  const recomputeMenu = (next: string, caret: number): void => {
    const mention = activeMention(next, caret)
    if (mention !== undefined) {
      setMenu('mention')
      setMenuQuery(mention)
      setMenuIdx(0)
      return
    }
    const cmd = activeCommandToken(next)
    if (cmd !== undefined) {
      setMenu('cmd')
      setMenuQuery(cmd)
      setMenuIdx(0)
      return
    }
    setMenu(null)
  }

  const cmdItems = SLASH_COMMANDS.filter((c) => c.startsWith(activeCommandToken(text) ?? ''))
  const q = menu === 'mention' ? menuQuery.toLowerCase() : ''
  const hostItems = conns
    .filter((c) => c.name.toLowerCase().includes(q) || c.host.toLowerCase().includes(q))
    .slice(0, MENU_MAX)

  const applyMenu = (): void => {
    const el = taRef.current
    const caret = el?.selectionStart ?? caretRef.current
    if (menu === 'cmd') {
      const id = cmdItems[menuIdx]
      if (!id) return
      const next = `/${id} `
      setText(next)
      setMenu(null)
      const pos = next.length
      requestAnimationFrame(() => {
        el?.focus()
        el?.setSelectionRange(pos, pos)
      })
      return
    }
    const host = hostItems[menuIdx]
    if (!host || !ai) return
    const before = text.slice(0, caret)
    const at = before.lastIndexOf('@')
    const next = `${text.slice(0, at)}@${host.name} ${text.slice(caret)}`
    setText(next)
    setMenu(null)
    const pos = at + host.name.length + 2
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  const submit = (): void => {
    if (!text.trim() || busy || disabled) return
    onSend(text)
    setText('')
    setMenu(null)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menu === 'cmd' || menu === 'mention') {
      const n = menu === 'cmd' ? cmdItems.length : hostItems.length
      if (n > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setMenuIdx((i) => (i + 1) % n)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setMenuIdx((i) => (i - 1 + n) % n)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          applyMenu()
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenu(null)
        return
      }
    }
    // Enter 发送；Cmd/Ctrl+Enter（或 Shift+Enter）换行；IME 组合中不误发
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return // 交给 textarea 默认换行
      e.preventDefault()
      submit()
    }
  }

  return (
    <div>
      {/* 输入区上方：审批档位（左）+ 宽松确认（选择器右侧）+ 待批时居中「查看审批项」 */}
      <div className="relative mb-2 flex min-h-6 items-center gap-1.5">
        <Select
          value={ai?.approvalLevel ?? 'default'}
          onValueChange={(v) => {
            if (v === 'relaxed') {
              setRelaxedConfirm(true)
              return
            }
            setRelaxedConfirm(false)
            if (ai) updatePrefs({ ai: { ...ai, approvalLevel: v as AiApprovalLevel } })
          }}
        >
          <SelectTrigger
            aria-label={t('settings.aiApprovalLevel')}
            className="h-5 w-auto shrink-0 gap-1 border-none bg-transparent px-1 text-caption shadow-none hover:bg-hover"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent side="top">
            {APPROVAL_LEVELS.map((o) => {
              const Icon = APPROVAL_ICONS[o.value]
              return (
                <SelectItem key={o.value} value={o.value} className="text-caption">
                  <span className="flex items-center gap-1.5">
                    <Icon size={11} className={APPROVAL_ICON_CLS[o.value]} />
                    {t(o.labelKey)}
                  </span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        {relaxedConfirm && (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className="min-w-0 flex-1 truncate text-caption text-danger"
              title={t('settings.aiRelaxedMessage')}
            >
              {t('settings.aiRelaxedMessage')}
            </span>
            <button
              type="button"
              className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-caption font-medium text-danger transition-colors hover:bg-danger/10"
              onClick={() => {
                setRelaxedConfirm(false)
                if (ai) updatePrefs({ ai: { ...ai, approvalLevel: 'relaxed' } })
              }}
            >
              {t('common.ok')}
            </button>
            <button
              type="button"
              className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-caption text-muted transition-colors hover:bg-hover hover:text-fg"
              onClick={() => setRelaxedConfirm(false)}
            >
              {t('common.cancel')}
            </button>
          </div>
        )}
        {humanPending > 0 && !relaxedConfirm && (
          <button
            type="button"
            onClick={onViewApprovals}
            className="ai-approval-jump absolute left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-warn/50 bg-warn/15 px-2.5 py-0.5 text-caption font-medium text-warn"
          >
            {pendingInputCount > 0 ? (
              <Lock size={11} strokeWidth={2.2} className="shrink-0" />
            ) : (
              <ShieldAlert size={11} strokeWidth={2.2} className="shrink-0" />
            )}
            {t(
              pendingQuestionCount > 0
                ? 'ai.viewQuestion'
                : pendingInputCount > 0
                  ? 'ai.viewInput'
                  : 'ai.viewApprovals'
            )}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {/* 大输入容器：光圈三态（审批/输入黄闪 · 会话活动彩虹 · 空闲普通描边+聚焦绿边） */}
        <div
          className={cn(
            'rounded-[var(--at-panel-radius)] border bg-raised transition-colors duration-100',
            humanPending > 0
              ? 'ai-ring-approval'
              : busy || hasRunningExec
                ? 'ai-ring-busy'
                : 'border-line focus-within:border-at-accent/60'
          )}
        >
          <div className="relative">
            {(focusedHost ||
              references.length > 0 ||
              (fileAttachments?.length ?? 0) > 0 ||
              (browserAttachments?.length ?? 0) > 0) && (
              <div className="flex flex-wrap gap-1 px-2 pt-2">
                {focusedHost && (
                  <span
                    title={`${focusedHost.host}:${focusedHost.port}`}
                    className="flex min-w-0 max-w-full items-center gap-1 rounded-md bg-hover px-2 py-1 text-caption text-muted"
                  >
                    <Server size={12} />
                    {t('ai.focusedHost')}: <span className="truncate">{focusedHost.name}</span>
                  </span>
                )}
                {browserAttachments?.map((reference) => (
                  <BrowserReferenceChip
                    key={reference.id}
                    reference={reference}
                    onRemove={() =>
                      useWorkspaceStore.getState().removeBrowser(sessionId, reference.id)
                    }
                  />
                ))}
                {fileAttachments?.map((file) => (
                  <FileReferenceChip
                    key={JSON.stringify([file.hostId, file.path])}
                    file={file}
                    onRemove={() =>
                      useWorkspaceStore.getState().removeFile(sessionId, file.hostId, file.path)
                    }
                  />
                ))}
                {references.map((host) => (
                  <span
                    key={host.id}
                    title={`${host.host}:${host.port}`}
                    className="flex max-w-full items-center gap-1 rounded-md border border-line bg-raised px-2 py-1 text-caption"
                  >
                    <Server size={12} />
                    <span className="truncate">{host.name}</span>
                    <IconButton
                      icon={X}
                      frame={18}
                      title={t('ai.removeHostReference')}
                      onClick={() => useWorkspaceStore.getState().removeHost(sessionId, host.id)}
                    />
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={taRef}
              rows={3}
              value={text}
              placeholder={placeholder}
              onChange={(e) => {
                setText(e.target.value)
                caretRef.current = e.target.selectionStart ?? 0
                recomputeMenu(e.target.value, e.target.selectionStart ?? 0)
              }}
              onKeyUp={() => {
                caretRef.current = taRef.current?.selectionStart ?? caretRef.current
              }}
              onClick={() => {
                caretRef.current = taRef.current?.selectionStart ?? caretRef.current
                recomputeMenu(text, taRef.current?.selectionStart ?? text.length)
              }}
              onKeyDown={onKeyDown}
              style={{ maxHeight: COMPOSER_MAX_H, minHeight: COMPOSER_MIN_H }}
              className="no-drag block w-full resize-none bg-transparent px-3 py-2 text-body leading-relaxed text-fg placeholder:text-muted outline-none"
            />
            {/* 补全菜单：锚在输入区上方 */}
            {menu !== null && (
              <div className="absolute bottom-full left-0 z-20 mb-1.5 max-h-56 w-80 overflow-y-auto rounded-lg border border-line bg-raised shadow-lg">
                {menu === 'cmd' ? (
                  cmdItems.length > 0 ? (
                    cmdItems.map((id, i) => (
                      <button
                        key={id}
                        type="button"
                        className={cn(
                          'flex w-full items-center gap-2 px-2.5 py-1.5 text-left',
                          i === menuIdx && 'bg-hover'
                        )}
                        onMouseEnter={() => setMenuIdx(i)}
                        onClick={applyMenu}
                      >
                        <span className="font-mono text-minor text-fg">/{id}</span>
                        <span className="ml-auto truncate text-caption text-muted">
                          {t(`ai.cmd.${id}Label`)} · {t(`ai.cmd.${id}Desc`)}
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="px-2.5 py-1.5 text-caption text-muted">
                      {t('ai.mentionNoHosts')}
                    </div>
                  )
                ) : hostItems.length > 0 ? (
                  hostItems.map((c, i) => (
                    <button
                      key={c.id}
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-2 px-2.5 py-1.5 text-left',
                        i === menuIdx && 'bg-hover'
                      )}
                      onMouseEnter={() => setMenuIdx(i)}
                      onClick={applyMenu}
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: linkStateColor(phases[c.id]?.phase) }}
                      />
                      <span className="shrink-0 font-mono text-minor text-fg">@{c.name}</span>
                      <span className="truncate text-caption text-muted">
                        {c.host}:{c.port}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-2.5 py-1.5 text-caption text-muted">
                    {t('ai.mentionNoHosts')}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 底部工具行：模型切换器（左）+ 发送/停止（右） */}
          <div className="relative flex items-center gap-1.5 px-2 pb-2 pt-0.5">
            <ExecutionSessionsButton key={sessionId} sessionId={sessionId} />
            <Select
              value={chatBinding?.model ? `${chatBinding.providerId}|${chatBinding.model}` : ''}
              onValueChange={(v) => {
                if (v === '__manage__') {
                  setTab({ kind: 'settings', section: 'ai' })
                  return
                }
                if (!ai) return
                const sep = v.indexOf('|')
                updatePrefs({
                  ai: {
                    ...ai,
                    scenarios: {
                      ...ai.scenarios,
                      chat: { providerId: v.slice(0, sep), model: v.slice(sep + 1) }
                    }
                  }
                })
              }}
            >
              <SelectTrigger
                aria-label={t('ai.modelTitle')}
                className="h-7 w-auto max-w-56 gap-1 border-none bg-transparent px-1.5 text-minor shadow-none hover:bg-hover"
              >
                <SelectValue placeholder={t('ai.modelNone')} />
              </SelectTrigger>
              <SelectContent side="top" className="max-h-72 w-80">
                {chatOptions.length === 0 ? (
                  <div className="px-2.5 py-1.5 text-caption text-muted">
                    {t('ai.modelMenuEmpty')}
                  </div>
                ) : (
                  chatOptions.map((o) => (
                    <SelectItem
                      key={`${o.providerId}|${o.model}`}
                      value={`${o.providerId}|${o.model}`}
                      className="text-minor"
                    >
                      <span className="flex w-full min-w-0 items-center gap-2">
                        <span className="w-20 shrink-0 truncate">{o.label}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-muted">
                          {o.model}
                        </span>
                      </span>
                    </SelectItem>
                  ))
                )}
                <SelectSeparator className="bg-chrome-sep" />
                <SelectItem value="__manage__" className="text-muted">
                  {t('ai.manageModels')}
                </SelectItem>
              </SelectContent>
            </Select>

            <span className="flex-1" />
            {busy ? (
              <button
                type="button"
                onClick={onCancel}
                title={t('ai.stop')}
                className="flex h-7 w-7 cursor-pointer shrink-0 items-center justify-center rounded-md bg-danger text-white transition-opacity hover:opacity-90"
              >
                <Square size={11} strokeWidth={2.4} />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!text.trim() || disabled}
                title={t('ai.send')}
                className="flex h-7 w-7 cursor-pointer shrink-0 items-center justify-center rounded-md bg-at-accent text-white transition-opacity hover:opacity-90 disabled:opacity-35"
              >
                <ArrowUp size={14} strokeWidth={2.6} />
              </button>
            )}
          </div>
        </div>
        {ai && chatBinding?.model && (
          <ContextUsageIndicator
            usage={contextUsage}
            recovery={recovery}
            modelKey={modelSettingsKey(chatBinding)}
            contextWindow={contextSettingsFor(ai).contextWindow}
          />
        )}
      </div>
    </div>
  )
}
