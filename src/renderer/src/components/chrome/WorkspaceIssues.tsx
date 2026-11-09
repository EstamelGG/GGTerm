import { useTranslation } from 'react-i18next'
import { useWorkspaceIssues } from '@/stores/workspaceIssues'
import { Button } from '@/components/form/Buttons'

export function WorkspaceIssues(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { issues, clear, retry } = useWorkspaceIssues()
  if (!Object.keys(issues).length) return null
  return (
    <div className="max-h-40 shrink-0 overflow-auto border-b border-line bg-sidebar">
      {Object.entries(issues).map(([scope, issue]) => (
        <div key={scope} role="alert" className="flex items-center gap-2 px-3 py-2 text-minor">
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-danger select-text">
            {t(`workspaceErrors.${issue.kind}`)}: {issue.message}
          </p>
          {issue.retry && (
            <Button
              variant="ghost"
              title={t('workspaceErrors.retry')}
              disabled={issue.pending}
              onClick={() => void retry(scope)}
            />
          )}
          <Button
            variant="text"
            title={t('workspaceErrors.dismiss')}
            onClick={() => clear(scope)}
          />
        </div>
      ))}
    </div>
  )
}
