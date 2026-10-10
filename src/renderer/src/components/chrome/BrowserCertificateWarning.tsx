import { ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BrowserCertificateError } from '@shared/browser'
import { Button } from '@/components/form/Buttons'

export function BrowserCertificateWarning({
  certificate,
  busy,
  onContinue,
  onLeave
}: {
  certificate: BrowserCertificateError
  busy: boolean
  onContinue: () => void
  onLeave: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const date = (value: number): string =>
    Number.isFinite(value) ? new Date(value).toLocaleString() : '—'
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div
        role="alert"
        className="my-auto flex w-full max-w-xl flex-col gap-4 rounded-xl border border-line bg-raised p-5"
      >
        <div className="flex items-center gap-2 text-warn">
          <ShieldAlert size={20} />
          <h2 className="text-title font-semibold">{t('browser.certificateTitle')}</h2>
        </div>
        <p className="text-body text-fg">{t('browser.certificateDescription')}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-minor">
          <dt className="text-muted">{t('browser.certificateSite')}</dt>
          <dd className="break-all font-mono">{certificate.origin}</dd>
          <dt className="text-muted">{t('browser.certificateError')}</dt>
          <dd className="break-all font-mono text-warn">{certificate.error}</dd>
          <dt className="text-muted">{t('browser.certificateSubject')}</dt>
          <dd className="break-all">{certificate.subject || '—'}</dd>
          <dt className="text-muted">{t('browser.certificateIssuer')}</dt>
          <dd className="break-all">{certificate.issuer || '—'}</dd>
          <dt className="text-muted">{t('browser.certificateValidity')}</dt>
          <dd>
            {date(certificate.validFrom)} – {date(certificate.validTo)}
          </dd>
          <dt className="text-muted">SHA-256</dt>
          <dd className="break-all font-mono">{certificate.fingerprint}</dd>
        </dl>
        <p className="text-minor text-muted">{t('browser.certificateScope')}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="ghost"
            title={t('browser.certificateLeave')}
            disabled={busy}
            onClick={onLeave}
          />
          <Button
            variant="danger"
            title={t('browser.certificateContinue')}
            disabled={busy}
            onClick={onContinue}
          />
        </div>
      </div>
    </div>
  )
}
