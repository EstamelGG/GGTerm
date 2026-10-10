import type { ReactNode } from 'react'
import { ChromeRow } from '@/components/chrome/ChromeRow'

/** Activity panels use the same workspace row as the sidebar and browser tabs. */
export function ActivityPanelHeader({ children }: { children: ReactNode }): React.JSX.Element {
  return <ChromeRow data-slot="activity-panel-header">{children}</ChromeRow>
}
