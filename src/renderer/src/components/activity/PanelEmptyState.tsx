import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

/** Compact, shared empty state for the narrow activity panels. */
export function PanelEmptyState({
  icon: Icon,
  title,
  description,
  children
}: {
  icon: LucideIcon
  title: string
  description?: string
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 px-3 py-6 text-center">
      <Icon size={22} strokeWidth={1.5} className="mb-1 text-muted" aria-hidden="true" />
      <p className="text-minor font-medium text-fg">{title}</p>
      {description && (
        <p className="max-w-60 text-caption leading-relaxed text-muted">{description}</p>
      )}
      {children && <div className="mt-1">{children}</div>}
    </div>
  )
}
