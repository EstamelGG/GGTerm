import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import type { LocalShells } from '@shared/localTerminal'
import { errorMessage } from '@shared/error'
import { usePrefsStore } from '@/stores/prefs'
import { SettingsRow } from './SettingsRow'
import { IconButton } from '@/components/ui/IconButton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

export function LocalShellSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const selected = usePrefsStore((s) => s.data?.localShell ?? '')
  const [scan, setScan] = useState<LocalShells>({ shells: [], defaultPath: '' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let live = true
    void window.aterm.localTerminal
      .shells()
      .then((result) => {
        if (live) setScan(result)
      })
      .catch((cause) => {
        if (live) setError(errorMessage(cause))
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [revision])
  const unavailable = selected && !scan.shells.some((shell) => shell.path === selected)
  return (
    <SettingsRow
      title={t('localTerminal.defaultShell')}
      desc={
        <>
          {t('localTerminal.shellHint')}
          {!selected && scan.defaultPath && (
            <div className="mt-1 font-mono">{scan.defaultPath}</div>
          )}
          {(error || (!loading && unavailable)) && (
            <div role="alert" className="mt-1 text-danger">
              {error || t('localTerminal.unavailable')}
            </div>
          )}
        </>
      }
    >
      <div className="flex min-w-0 items-center gap-2">
        <Select
          value={selected || 'system'}
          disabled={loading}
          onValueChange={(value) =>
            usePrefsStore.getState().update({ localShell: value === 'system' ? '' : value })
          }
        >
          <SelectTrigger className="max-w-80" aria-label={t('localTerminal.defaultShell')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">{t('localTerminal.systemDefault')}</SelectItem>
            {unavailable && (
              <SelectItem value={selected} disabled>
                {selected} · {t('localTerminal.unavailable')}
              </SelectItem>
            )}
            {scan.shells.map((shell) => (
              <SelectItem key={shell.path} value={shell.path}>
                {shell.label} · <span className="font-mono">{shell.path}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <IconButton
          icon={RefreshCw}
          title={t('localTerminal.rescan')}
          disabled={loading}
          onClick={() => {
            setLoading(true)
            setError('')
            setRevision((value) => value + 1)
          }}
        />
      </div>
    </SettingsRow>
  )
}
