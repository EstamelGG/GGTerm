import type { ReactElement } from 'react'
import { Tooltip } from 'radix-ui'

/** Portal keeps toolbar hints visible outside clipped panes and tab strips. */
export function ButtonTooltip({
  label,
  delayDuration = 350,
  children
}: {
  label?: string
  /** 悬浮多久后弹出（毫秒）；默认 350ms */
  delayDuration?: number
  children: ReactElement
}): React.JSX.Element {
  if (!label) return children
  return (
    <Tooltip.Provider delayDuration={delayDuration}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            sideOffset={6}
            className="pointer-events-none z-[100] max-w-64 rounded-md border border-line bg-raised px-2 py-1 text-minor text-fg shadow-md"
          >
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
