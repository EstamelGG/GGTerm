import { useEffect, useRef, useState } from 'react'
import { Plus, TerminalSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { localTerminalKey } from '@shared/localTerminal'
import { errorMessage } from '@shared/error'
import { useLocalTerminalStore } from '@/stores/localTerminal'
import { usePrefsStore } from '@/stores/prefs'
import { TerminalPane } from '@/components/terminal/TerminalPane'
import { TabChip, TabScrollArea } from '@/components/chrome/TabChip'
import { IconButton } from '@/components/ui/IconButton'
import { DialogShell } from '@/components/ui/DialogShell'
import { Button } from '@/components/form/Buttons'
import { cn } from '@/lib/utils'
import { focusTerminal } from '@/terminal/registry'
import { loadTerminalFonts } from '@/terminal/theme'

export function LocalTerminalPage({
  active,
  onToast
}: {
  active: boolean
  onToast: (text: string, danger?: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { tabs, activeId, creating, create, close, select } = useLocalTerminalStore()
  const confirmClose = usePrefsStore((s) => s.data?.confirmCloseSession ?? true)
  const initialized = useRef(false)
  const [pendingClose, setPendingClose] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const current = tabs.find((tab) => tab.id === activeId)
  const add = (): void => {
    void create().catch((error) => onToast(errorMessage(error), true))
  }
  useEffect(() => {
    if (!active || initialized.current) return
    initialized.current = true
    if (!useLocalTerminalStore.getState().tabs.length)
      void create().catch((error) => onToast(errorMessage(error), true))
  }, [active, create, onToast])
  useEffect(() => {
    if (!active || !activeId) return
    let live = true
    void loadTerminalFonts()
      .catch(() => {})
      .then(() => {
        if (live) focusTerminal(localTerminalKey(activeId))
      })
    return () => {
      live = false
    }
  }, [active, activeId])
  const remove = async (id: string): Promise<void> => {
    setClosing(true)
    try {
      await close(id)
      setPendingClose(null)
    } catch (error) {
      onToast(errorMessage(error), true)
    } finally {
      setClosing(false)
    }
  }
  return (
    <div className={cn('absolute inset-0 flex flex-col bg-bg', !active && 'hidden')}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-chrome-bar px-3">
        <TabScrollArea>
          {tabs.map((tab) => (
            <TabChip
              key={tab.id}
              title={`${t('localTerminal.tab')} ${tab.number}`}
              icon={TerminalSquare}
              selected={tab.id === activeId}
              showClose
              onClick={() => select(tab.id)}
              onClose={() => {
                if (confirmClose && tab.exitCode === undefined) setPendingClose(tab.id)
                else void remove(tab.id)
              }}
            />
          ))}
        </TabScrollArea>
        <IconButton icon={Plus} title={t('localTerminal.new')} disabled={creating} onClick={add} />
      </div>
      {current ? (
        <>
          <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-1 text-caption text-muted">
            <span>{current.shell}</span>
            <span className="min-w-0 truncate font-mono" title={current.cwd}>
              {current.cwd}
            </span>
            {current.exitCode !== undefined && (
              <span>{t('localTerminal.exited', { code: current.exitCode })}</span>
            )}
          </div>
          {current.error && (
            <p role="alert" className="px-3 py-1 text-minor text-danger">
              {current.error}
            </p>
          )}
          <TerminalPane
            key={current.id}
            instanceKey={localTerminalKey(current.id)}
            className="min-h-0 flex-1"
            acceptLocalFiles
            localShell={current.shell}
          />
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <Button title={t('localTerminal.new')} disabled={creating} onClick={add} />
        </div>
      )}
      {pendingClose && (
        <DialogShell
          open
          title={t('localTerminal.closeTitle')}
          dismissable={!closing}
          onOpenChange={(open) => {
            if (!open) setPendingClose(null)
          }}
          footer={
            <>
              <Button
                variant="ghost"
                title={t('common.cancel')}
                disabled={closing}
                onClick={() => setPendingClose(null)}
              />
              <Button
                variant="danger"
                title={t('common.close')}
                disabled={closing}
                onClick={() => void remove(pendingClose)}
              />
            </>
          }
        >
          <p className="text-body text-muted">{t('localTerminal.closeMessage')}</p>
        </DialogShell>
      )}
    </div>
  )
}
