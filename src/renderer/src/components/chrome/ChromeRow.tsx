import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '@/lib/utils'
import { ChromeSeparator } from './ChromeSeparator'
import { CHROME_ROW } from './layout'

interface ChromeRowProps extends ComponentPropsWithoutRef<'div'> {
  /** The separator is outside the shared content height, keeping adjacent panels aligned. */
  separator?: boolean
  scrollable?: boolean
}

/** Shared workspace toolbar/tab row. Geometry comes exclusively from --at-chrome-row-* tokens. */
export function ChromeRow({
  children,
  className,
  separator = true,
  scrollable = false,
  ...props
}: ChromeRowProps): React.JSX.Element {
  return (
    <>
      <div
        data-slot="chrome-row"
        {...props}
        className={cn(CHROME_ROW, scrollable && 'overflow-x-auto', className)}
      >
        {children}
      </div>
      {separator && <ChromeSeparator />}
    </>
  )
}
