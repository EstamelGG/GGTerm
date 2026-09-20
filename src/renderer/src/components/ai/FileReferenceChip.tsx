import { FileText, Folder, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AiFileReference } from '@shared/types'
import { IconButton } from '@/components/ui/IconButton'

export function FileReferenceChip({
  file,
  onRemove
}: {
  file: AiFileReference
  onRemove?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const Icon = file.isDir ? Folder : FileText
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-raised px-2 py-1 text-caption"
      title={`${file.hostName} · ${file.username}@${file.host}:${file.port}\n${file.path}`}
    >
      <Icon size={12} className="shrink-0" />
      <span className="min-w-0 truncate">
        {file.hostName}: {file.path}
      </span>
      {onRemove && (
        <IconButton icon={X} frame={18} title={t('ai.removeFileReference')} onClick={onRemove} />
      )}
    </span>
  )
}
