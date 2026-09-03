import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TerminalSquare } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'

const ExecutionSessionsDialog = lazy(() => import('./ExecutionSessionsDialog'))

/** Kept in the composer; terminal dependencies load only when the viewer is opened. */
export function ExecutionSessionsButton({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton
        variant="toolbar"
        icon={TerminalSquare}
        title={t('execution.title')}
        onClick={() => setOpen(true)}
      />
      {open && (
        <Suspense fallback={null}>
          <ExecutionSessionsDialog sessionId={sessionId} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  )
}
