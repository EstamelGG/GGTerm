import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { localTerminalKey } from '@shared/localTerminal'
import { errorMessage } from '@shared/error'
import { useLocalTerminalStore } from '@/stores/localTerminal'
import { usePrefsStore } from '@/stores/prefs'
import { WorkspacePane } from '@/components/terminal/WorkspacePane'
import { CHROME_ROW } from '@/components/chrome/layout'
import { shellStateDot } from '@/lib/linkPhase'
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
    <div className={cn('absolute inset-0 flex flex-col bg-sidebar', !active && 'hidden')}>
      <div className={cn(CHROME_ROW, 'bg-sidebar')}>
        <TabScrollArea>
          {tabs.map((tab) => (
            <TabChip
              key={tab.id}
              title={`${t('localTerminal.tab')} ${tab.number}`}
              accentBorder={false}
              statusColor={shellStateDot(
                tab.error ? 'error' : tab.exitCode === undefined ? 'connected' : 'ended'
              )}
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
        <IconButton
          variant="toolbar"
          size={10}
          frame={22}
          cornerRadius={11}
          filled
          icon={Plus}
          title={t('localTerminal.new')}
          disabled={creating}
          onClick={add}
        />
      </div>
      <div className="relative min-h-0 flex-1 bg-sidebar">
        {current ? (
          <WorkspacePane
            overlay={
              current.error || current.exitCode !== undefined ? (
                <div className="absolute inset-x-0 top-0 flex justify-center pt-5">
                  <span
                    role={current.error ? 'alert' : 'status'}
                    className="glass max-w-[80%] truncate rounded-full px-2.5 py-[5px] text-caption font-medium text-fg"
                  >
                    {current.error || t('localTerminal.exited', { code: current.exitCode })}
                  </span>
                </div>
              ) : undefined
            }
          >
            <TerminalPane
              key={current.id}
              instanceKey={localTerminalKey(current.id)}
              acceptLocalFiles
              localShell={current.shell}
            />
          </WorkspacePane>
        ) : (
          <div className="flex h-full items-center justify-center">
            <Button title={t('localTerminal.new')} disabled={creating} onClick={add} />
          </div>
        )}
      </div>
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
