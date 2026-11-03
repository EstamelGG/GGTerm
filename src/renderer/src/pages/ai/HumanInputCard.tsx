import { ghostPillCls } from '@/components/form/Buttons'
import { SecretField } from '@/components/form/Secrets'
import { cn } from '@/lib/utils'
import { useConnectionsStore } from '@/stores/connections'
import { errorMessage } from '@shared/error'
import type { HumanInputRequest } from '@shared/execution'
import { Check, Lock, SquareTerminal, X } from 'lucide-react'
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * 人工输入卡片（密码 / 验证码等敏感提示）：排在对话末尾，与 VS Code 的提问卡同位置。
 * 刻意不嵌进历史里的工具卡：同一 executionId 会出现在多张工具卡上（start 的结果、poll/input 的入参），
 * 按 id 嵌入会重复渲染；且处理时用户视线就在末尾。
 * 值只存在于本组件 state，提交后立刻清空 —— 不经模型、不进日志、不落盘。
 */
export const HumanInputCard = memo(function HumanInputCard({
  request
}: {
  request: HumanInputRequest
}): React.JSX.Element {
  const { t } = useTranslation()
  const conn = useConnectionsStore((s) => s.connections.find((c) => c.id === request.hostId))
  /** 待提交的敏感值：本组件 state → 一次 IPC → PTY，不落任何持久层 */
  const [secret, setSecret] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const hostLabel =
    request.target === 'browser'
      ? request.url
      : conn
        ? `${conn.name} (${conn.host})`
        : request.hostId

  const submit = (): void => {
    if (secret.trim() === '' || submitting) return
    setSubmitting(true)
    setError('')
    void window.aterm.humanInput
      .submit(request.sessionId, request.executionId, secret)
      .then(() => setSecret(''))
      .catch((err: unknown) => {
        setSecret('')
        setError(errorMessage(err))
      })
      .finally(() => setSubmitting(false))
  }
  const terminate = (): void => {
    setError('')
    void window.aterm.humanInput
      .cancel(request.sessionId, request.executionId)
      .catch((err: unknown) => setError(errorMessage(err)))
  }

  return (
    <div
      data-input-pending=""
      className="rounded-md border border-warn/40 bg-raised/50 px-2.5 py-2 text-minor"
    >
      {/* 抬头沿用工具卡行式样：状态图标 + 工具名@主机 + 右端状态徽标 */}
      <div className="flex items-center gap-2">
        <Lock size={12} strokeWidth={2.2} className="shrink-0 text-warn" />
        <SquareTerminal size={12} strokeWidth={2.2} className="shrink-0 text-muted" />
        <span className="shrink-0 font-mono text-fg">
          {request.target === 'browser' ? 'browser' : 'execute'}
        </span>
        <span title={hostLabel} className="min-w-0 truncate text-caption text-muted">
          @ {hostLabel}
        </span>
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 rounded bg-warn/15 px-1 py-0.5 text-caption text-warn">
          {t('ai.inputNeeded')}
        </span>
      </div>
      {request.command && (
        <div className="mt-1 truncate font-mono text-caption text-muted">$ {request.command}</div>
      )}
      {request.prompt && (
        <div className="mt-1.5 select-text overflow-hidden whitespace-pre-wrap break-all rounded border border-line bg-black/25 px-2 py-1 font-mono text-caption text-fg/90">
          {request.prompt}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-2">
        <SecretField
          value={secret}
          onChange={setSecret}
          placeholder={t('ai.inputPlaceholder')}
          className="h-6 min-w-0 flex-1"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            else if (e.key === 'Escape') setSecret('')
          }}
        />
        <button
          type="button"
          disabled={secret.trim() === '' || submitting}
          className={cn(
            ghostPillCls,
            'flex h-6 items-center gap-1 bg-ok/40 px-3 text-minor font-medium text-fg hover:bg-ok/50 disabled:opacity-35'
          )}
          onClick={submit}
        >
          <Check size={12} strokeWidth={2.4} className="text-ok brightness-150" />
          {t('ai.inputSubmit')}
        </button>
        <button
          type="button"
          disabled={submitting}
          className={cn(
            ghostPillCls,
            'flex h-6 items-center gap-1 px-3 text-minor font-medium text-danger hover:bg-hover'
          )}
          onClick={terminate}
        >
          <X size={12} strokeWidth={2.4} />
          {request.target === 'browser' ? t('common.cancel') : t('ai.inputTerminate')}
        </button>
      </div>
      {error && <p className="mt-1 text-caption text-danger">{error}</p>}
    </div>
  )
})
