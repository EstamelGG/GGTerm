import { Globe, MousePointer2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AiBrowserReference } from '@shared/browser'
import { IconButton } from '@/components/ui/IconButton'

export function BrowserReferenceChip({
  reference,
  onRemove
}: {
  reference: AiBrowserReference
  onRemove?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const Icon = reference.kind === 'element' ? MousePointer2 : Globe
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-raised px-2 py-1 text-caption"
      title={`${reference.url}\n${reference.element?.selector ?? ''}\n${reference.content.slice(0, 400)}`}
    >
      <Icon size={12} className="shrink-0" />
      <span className="min-w-0 truncate">
        {reference.title || reference.url}
        {reference.element ? ` · ${reference.element.tagName}` : ''}
      </span>
      {onRemove && (
        <IconButton icon={X} frame={18} title={t('browser.removeReference')} onClick={onRemove} />
      )}
    </span>
  )
}
