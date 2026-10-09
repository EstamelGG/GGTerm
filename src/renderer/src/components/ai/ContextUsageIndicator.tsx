import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AiContextUsage, AiRecoveryState } from '@shared/types'

const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

function RecoveryStatus({ recovery }: { recovery: AiRecoveryState }): React.JSX.Element {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <span className="text-warn" role="status">
      {t(now >= recovery.retryAt ? 'ai.reconnecting' : 'ai.recovering', {
        attempt: recovery.attempt,
        max: recovery.maxAttempts,
        seconds: Math.max(0, Math.ceil((recovery.retryAt - now) / 1000))
      })}
    </span>
  )
}

export function ContextUsageIndicator({
  usage,
  modelKey,
  contextWindow,
  recovery
}: {
  usage?: AiContextUsage
  modelKey: string
  contextWindow: number
  recovery?: AiRecoveryState
}): React.JSX.Element {
  const { t } = useTranslation()
  // 切换模型/窗口后不能沿用旧模型的请求统计，等待下一次实际请求更新。
  const current =
    usage?.modelKey === modelKey && usage.contextWindow === contextWindow ? usage : undefined
  const percent = current ? Math.round((current.inputTokens / contextWindow) * 100) : undefined
  const text = current
    ? `${current.source === 'estimate' ? '≈ ' : ''}${compactNumber.format(current.inputTokens)} / ${compactNumber.format(contextWindow)} · ${percent}%`
    : `— / ${compactNumber.format(contextWindow)}`
  const title = current
    ? t(current.source === 'estimate' ? 'ai.contextUsageEstimate' : 'ai.contextUsageReported', {
        used: current.inputTokens.toLocaleString(),
        limit: contextWindow.toLocaleString()
      })
    : t('ai.contextUsagePending')
  return (
    <div
      className="flex flex-wrap items-center justify-end gap-1.5 px-1 text-caption text-muted"
      title={title}
      aria-label={`${t('ai.contextUsage')}: ${text}. ${title}`}
    >
      {recovery && <RecoveryStatus key={recovery.retryAt} recovery={recovery} />}
      {current?.phase === 'compressing' && (
        <>
          <Loader2 size={11} className="animate-spin" />
          <span>{t('ai.contextCompressing')}</span>
        </>
      )}
      <span>{t('ai.contextUsage')}</span>
      <span
        className={percent !== undefined && percent >= 75 ? 'font-mono text-warn' : 'font-mono'}
      >
        {text}
      </span>
    </div>
  )
}
