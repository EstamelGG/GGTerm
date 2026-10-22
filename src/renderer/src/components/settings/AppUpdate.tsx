import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppUpdateResult } from '@shared/appUpdate'
import { errorMessage } from '@shared/error'
import { Button } from '@/components/form/Buttons'

export function AppUpdate(): React.JSX.Element {
  const { t } = useTranslation()
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<AppUpdateResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const check = async (): Promise<void> => {
    setChecking(true)
    setError(null)
    setResult(null)
    try {
      setResult(await window.aterm.appUpdate.check())
    } catch (cause) {
      const message = errorMessage(cause)
      const key = (['NO_RELEASE', 'RATE_LIMITED', 'RELEASE_NOT_READY'] as const).find((code) =>
        message.includes(code)
      )
      setError(t(key ? `appUpdate.${key}` : 'appUpdate.failed'))
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="mt-3 flex w-full max-w-xl flex-col items-center gap-3">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          title={t(checking ? 'appUpdate.checking' : 'appUpdate.check')}
          disabled={checking}
          onClick={() => void check()}
        />
        {result?.available && (
          <Button
            title={t('appUpdate.download')}
            onClick={() => {
              void window.aterm.appUpdate.open().catch(() => setError(t('appUpdate.openFailed')))
            }}
          />
        )}
      </div>
      <div role="status" aria-live="polite" className="text-minor text-muted">
        {error ||
          (result &&
            t(result.available ? 'appUpdate.available' : 'appUpdate.latest', {
              version: result.latestVersion
            }))}
      </div>
      {result?.available && result.notes && (
        <div className="max-h-64 w-full overflow-auto whitespace-pre-wrap rounded-md border border-line bg-raised p-3 text-left text-body text-fg">
          {result.notes}
        </div>
      )}
    </div>
  )
}
