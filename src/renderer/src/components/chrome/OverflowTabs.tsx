import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Ellipsis } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { StateDot } from '@/components/ui/StateDot'
import type { StateDotVisual } from '@/lib/linkPhase'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

interface OverflowTab {
  id: string
  title: string
  selected: boolean
  statusColor?: StateDotVisual
  onSelect: () => void
  content: ReactNode
}

/** Fit complete tabs, reserving space for the menu; prefer the selected tab on overflow. */
function fitTabs(widths: number[], available: number, selected: number): Set<number> {
  const total = widths.reduce((sum, width) => sum + width + 4, -4)
  if (total <= available) return new Set(widths.map((_, i) => i))
  let remaining = Math.max(0, available - 30)
  const visible = new Set<number>()
  const order =
    selected >= 0
      ? [selected, ...widths.map((_, i) => i).filter((i) => i !== selected)]
      : widths.map((_, i) => i)
  for (const i of order) {
    if (widths[i] <= remaining) {
      visible.add(i)
      remaining -= widths[i] + 4
    }
  }
  return visible
}

export function OverflowTabs({ tabs }: { tabs: OverflowTab[] }): React.JSX.Element {
  const { t } = useTranslation()
  const root = useRef<HTMLDivElement>(null)
  const [sizes, setSizes] = useState<{ available: number; widths: Record<string, number> }>({
    available: 0,
    widths: {}
  })
  const keys = tabs.map((tab) => tab.id).join('|')
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const measure = (): void => {
      const widths: Record<string, number> = {}
      element.querySelectorAll<HTMLElement>('[data-overflow-tab]').forEach((node) => {
        widths[node.dataset.overflowTab!] = node.getBoundingClientRect().width
      })
      const next = { available: element.clientWidth, widths }
      setSizes((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
    }
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(measure, 150)
    })
    observer.observe(element)
    element
      .querySelectorAll<HTMLElement>('[data-overflow-tab]')
      .forEach((node) => observer.observe(node))
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [keys])
  const visible = fitTabs(
    tabs.map((tab) => sizes.widths[tab.id] ?? Infinity),
    sizes.available,
    tabs.findIndex((tab) => tab.selected)
  )
  const hidden = tabs.filter((_, i) => !visible.has(i))
  return (
    <div ref={root} className="relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
      {tabs.map((tab, i) => (
        <div
          key={tab.id}
          data-overflow-tab={tab.id}
          aria-hidden={!visible.has(i)}
          inert={!visible.has(i)}
          className={
            visible.has(i)
              ? 'shrink-0'
              : 'invisible pointer-events-none absolute left-0 top-0 w-max'
          }
        >
          {tab.content}
        </div>
      ))}
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              variant="toolbar"
              icon={Ellipsis}
              title={t('chrome.moreTabs', { count: hidden.length })}
              aria-label={t('chrome.moreTabs', { count: hidden.length })}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {hidden.map((tab) => (
              <DropdownMenuItem key={tab.id} onSelect={tab.onSelect} textValue={tab.title}>
                {tab.statusColor && <StateDot visual={tab.statusColor} />}
                <span className="max-w-64 truncate" title={tab.title}>
                  {tab.title}
                </span>
                {tab.selected && <Check className="ml-auto" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
