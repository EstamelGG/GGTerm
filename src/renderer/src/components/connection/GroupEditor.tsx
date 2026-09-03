import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { HostGroup } from '@shared/types'
import { groupColors } from '@/lib/theme'
import { useConnectionsStore } from '@/stores/connections'
import { ATField, Button } from '@/components/form/Buttons'
import { ATTextField } from '@/components/form/Fields'
import { HexColorPicker } from '@/components/form/HexColorPicker'
import { DialogShell } from '@/components/ui/DialogShell'

export type GroupEditorPayload =
  { kind: 'create'; parentId: string | null } | { kind: 'edit'; group: HostGroup }

/** 对照 GroupEditor.swift：380 宽，名称 + 颜色 */
export function GroupEditor({
  payload,
  onDismiss
}: {
  payload: GroupEditorPayload
  onDismiss: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const createGroup = useConnectionsStore((s) => s.createGroup)
  const updateGroup = useConnectionsStore((s) => s.updateGroup)
  const editing = payload.kind === 'edit' ? payload.group : null

  const initial = useMemo(
    () => ({ name: editing?.name ?? '', color: editing?.colorHex ?? groupColors[0] }),
    [editing]
  )
  const [name, setName] = useState(initial.name)
  const [color, setColor] = useState(initial.color)

  const persist = (): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (editing) {
      void updateGroup(editing.id, { name: trimmed, colorHex: color })
    } else {
      void createGroup({
        name: trimmed,
        colorHex: color,
        parentId: payload.kind === 'create' ? payload.parentId : null
      })
    }
    onDismiss()
  }

  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && onDismiss()}
      title={editing ? t('conn.renameGroup') : t('conn.newGroup')}
      width={380}
      preventAutoFocus
      footer={
        <>
          <Button variant="ghost" title={t('common.cancel')} onClick={onDismiss} />
          <Button
            title={editing ? t('common.save') : t('common.create')}
            disabled={name.trim() === ''}
            onClick={persist}
          />
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ATField title={t('conn.groupName')}>
          <ATTextField value={name} onChange={setName} placeholder={t('conn.groupName')} />
        </ATField>
        <ATField title={t('conn.groupColor')}>
          <HexColorPicker hex={color} onChange={setColor} />
        </ATField>
      </div>
    </DialogShell>
  )
}
