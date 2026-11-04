import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { HostGroup } from '@shared/types'
import { groupColors } from '@/lib/theme'
import { useConnectionsStore } from '@/stores/connections'
import { ATField, Button } from '@/components/form/Buttons'
import { ATTextField } from '@/components/form/Fields'
import { HexColorPicker } from '@/components/form/HexColorPicker'
import { DialogShell } from '@/components/ui/DialogShell'
import { errorMessage } from '@shared/error'

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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const persist = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError('')
    try {
      if (editing) await updateGroup(editing.id, { name: trimmed, colorHex: color })
      else
        await createGroup({
          name: trimmed,
          colorHex: color,
          parentId: payload.kind === 'create' ? payload.parentId : null
        })
      onDismiss()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && !busy && onDismiss()}
      dismissable={!busy}
      title={editing ? t('conn.renameGroup') : t('conn.newGroup')}
      width={380}
      preventAutoFocus
      footer={
        <>
          <Button variant="ghost" title={t('common.cancel')} disabled={busy} onClick={onDismiss} />
          <Button
            title={editing ? t('common.save') : t('common.create')}
            disabled={busy || name.trim() === ''}
            onClick={() => void persist()}
          />
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="break-words text-minor text-danger">
            {error}
          </p>
        )}
        <ATField title={t('conn.groupName')}>
          <ATTextField
            value={name}
            onChange={setName}
            placeholder={t('conn.groupName')}
            disabled={busy}
            autoFocus
          />
        </ATField>
        <ATField title={t('conn.groupColor')}>
          <HexColorPicker hex={color} onChange={setColor} />
        </ATField>
      </div>
    </DialogShell>
  )
}
