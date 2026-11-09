import type { ReactNode } from 'react'

export function SettingsRow({
  title,
  desc,
  children
}: {
  title: string
  desc?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-stretch gap-2 rounded-lg border border-line px-3 py-2.5 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-4">
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <div className="text-body text-fg">{title}</div>
        {desc && <div className="mt-0.5 text-caption leading-relaxed text-muted">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
