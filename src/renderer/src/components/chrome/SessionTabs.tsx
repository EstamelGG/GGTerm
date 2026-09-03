import { OverflowTabs } from './OverflowTabs'
import { TabChip } from './TabChip'
import { CloseTabsMenu } from './CloseTabsMenu'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import type { StateDotVisual } from '@/lib/linkPhase'

interface SessionTab {
  id: string
  title: string
  statusColor: StateDotVisual
}

/** 本地与 SSH 共用溢出选择、标签和批量关闭行为。 */
export function SessionTabs({
  tabs,
  selectedId,
  onSelect,
  onClose
}: {
  tabs: SessionTab[]
  selectedId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
}): React.JSX.Element {
  return (
    <OverflowTabs
      tabs={tabs.map((tab, index) => ({
        ...tab,
        selected: selectedId === tab.id,
        onSelect: () => onSelect(tab.id),
        content: (
          <ContextMenu key={tab.id}>
            <ContextMenuTrigger asChild>
              <TabChip
                title={tab.title}
                statusColor={tab.statusColor}
                selected={selectedId === tab.id}
                accentBorder={false}
                showClose
                onClick={() => onSelect(tab.id)}
                onClose={() => onClose(tab.id)}
              />
            </ContextMenuTrigger>
            <CloseTabsMenu
              onClose={() => onClose(tab.id)}
              onCloseOthers={() =>
                tabs.filter((other) => other.id !== tab.id).forEach((other) => onClose(other.id))
              }
              onCloseRight={() => tabs.slice(index + 1).forEach((other) => onClose(other.id))}
              onCloseAll={() => tabs.forEach((other) => onClose(other.id))}
            />
          </ContextMenu>
        )
      }))}
    />
  )
}
