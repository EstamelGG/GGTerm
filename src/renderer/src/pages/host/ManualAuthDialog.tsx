import { ATField, Button } from '@/components/form/Buttons'
import { ATTextField, CheckBox } from '@/components/form/Fields'
import { SecretEditor, SecretField } from '@/components/form/Secrets'
import { ChoiceChip } from '@/components/ui/ChoiceChip'
import { DialogShell } from '@/components/ui/DialogShell'
import { useSessionStore, type HostWorkspaceMirror } from '@/stores/session'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export function ManualAuthDialog({
  host,
  onClose
}: {
  host: HostWorkspaceMirror
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const submitAuth = useSessionStore((s) => s.submitAuth)
  const [authUser, setAuthUser] = useState(host.conn.username)
  const [authPassword, setAuthPassword] = useState('')
  const [authMode, setAuthMode] = useState<'password' | 'privateKey'>('password')
  const [authKey, setAuthKey] = useState('')
  const [authPassphrase, setAuthPassphrase] = useState('')
  const [savePwd, setSavePwd] = useState(false)
  const canSubmitAuth =
    authUser.trim() !== '' &&
    (authMode === 'password' ? authPassword !== '' : authKey.trim() !== '')

  return (
    <>
      {/* 手动认证：提交凭据或取消当前连接。 */}
      <DialogShell
        open={host.awaiting}
        onOpenChange={(open) => !open && onClose()}
        preventAutoFocus
        title={t('session.manualLoginTitle')}
        width={360}
        footer={
          <>
            <Button variant="ghost" title={t('common.cancel')} onClick={onClose} />
            <Button
              title={t('common.connect')}
              disabled={!canSubmitAuth}
              onClick={() => {
                submitAuth(host.id, {
                  username: authUser,
                  password: authMode === 'password' ? authPassword : undefined,
                  privateKey: authMode === 'privateKey' ? authKey : undefined,
                  passphrase: authMode === 'privateKey' ? authPassphrase : undefined,
                  persist: savePwd
                })
                setAuthPassword('')
                setAuthKey('')
                setAuthPassphrase('')
                setSavePwd(false)
              }}
            />
          </>
        }
      >
        {host.offlineReason && (
          <p role="alert" className="mb-3 whitespace-pre-wrap break-words text-minor text-danger">
            {host.offlineReason}
          </p>
        )}
        <p className="break-all font-mono text-minor text-muted">
          {host.conn.host}:{host.conn.port}
        </p>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex gap-2">
            <ChoiceChip
              shape="pill"
              selected={authMode === 'password'}
              onClick={() => setAuthMode('password')}
            >
              {t('conn.form.authPassword')}
            </ChoiceChip>
            <ChoiceChip
              shape="pill"
              selected={authMode === 'privateKey'}
              onClick={() => setAuthMode('privateKey')}
            >
              {t('conn.form.authPrivateKey')}
            </ChoiceChip>
          </div>
          <ATField title={t('session.username')}>
            <ATTextField value={authUser} onChange={setAuthUser} autoFocus />
          </ATField>
          {authMode === 'password' ? (
            <ATField title={t('session.password')}>
              <SecretField value={authPassword} onChange={setAuthPassword} />
            </ATField>
          ) : (
            <>
              <ATField title={t('conn.form.privateKey')}>
                <SecretEditor
                  value={authKey}
                  onChange={setAuthKey}
                  placeholder={t('conn.form.privateKeyPlaceholder')}
                  minHeight={96}
                />
              </ATField>
              <ATField title={t('conn.form.passphrase')}>
                <SecretField value={authPassphrase} onChange={setAuthPassphrase} />
              </ATField>
            </>
          )}
          <div className="flex items-center">
            <button
              type="button"
              aria-pressed={savePwd}
              className="flex cursor-pointer items-center gap-1.5 rounded-sm outline-none focus-visible:ring-[1.5px] focus-visible:ring-at-accent/70"
              onClick={() => setSavePwd((v) => !v)}
            >
              <CheckBox state={savePwd ? 'on' : 'off'} />
              <span className="text-minor text-muted">
                {t(authMode === 'password' ? 'session.savePassword' : 'session.saveKey')}
              </span>
            </button>
          </div>
        </div>
      </DialogShell>
    </>
  )
}
