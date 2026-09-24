import { useTranslation } from 'react-i18next'
import { TerminalSquare } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { openExecutionTabs } from '@/stores/executionTabs'
import { useState } from 'react'
import { errorMessage } from '@shared/error'
export function ExecutionSessionsButton({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [error, setError] = useState('')
  return (
    <>
      <IconButton
        variant="toolbar"
        icon={TerminalSquare}
        title={t('execution.title')}
        onClick={() => {
          setError('')
          void openExecutionTabs(sessionId).catch((e) => setError(errorMessage(e)))
        }}
      />
      {error && (
        <span role="alert" className="text-minor text-danger">
          {error}
        </span>
      )}
    </>
  )
}
