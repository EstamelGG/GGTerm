import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Play, Trash2 } from 'lucide-react'
import { errorMessage } from '@shared/error'
import { useLocalTerminalStore } from '@/stores/localTerminal'
import { useSessionStore } from '@/stores/session'
import { useCommandsStore } from '@/stores/commands'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/form/Buttons'
import { ATTextField, ATTextArea } from '@/components/form/Fields'

/**
 * 快捷指令库由本地与 SSH 终端共用，写入与各自键盘输入走同一通道。
 */

export function CommandsPanel({
  target
}: {
  target: { kind: 'host'; hostId: string } | { kind: 'local' }
}): React.JSX.Element {
  const { t } = useTranslation()
  const commands = useCommandsStore((s) => s.commands)
  const addCommand = useCommandsStore((s) => s.add)
  const updateCommand = useCommandsStore((s) => s.update)
  const removeCommand = useCommandsStore((s) => s.remove)

  const hostId = target.kind === 'host' ? target.hostId : null
  const host = useSessionStore((s) => s.hosts.find((h) => h.id === hostId))
  const local = useLocalTerminalStore((s) => s.tabs.find((tab) => tab.id === s.activeId))
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)

  const [editing, setEditing] = useState<{ id: string } | 'new' | null>(null)
  const [name, setName] = useState('')
  const [cmdText, setCmdText] = useState('')

  const focusedShell = host?.shells.find((s) => s.id === host.focusShellId) ?? host?.shells[0]
  const runnable =
    target.kind === 'local'
      ? !!local && local.exitCode === undefined
      : host?.phase === 'connected' && focusedShell?.status === 'connected'
  const targetKey =
    target.kind === 'local' ? `local:${local?.id}` : `host:${hostId}:${focusedShell?.id}`

  const run = async (command: string): Promise<void> => {
    if (!runnable) return
    setFailure(null)
    try {
      if (target.kind === 'local' && local) {
        const text = command.replace(/\r?\n/g, '\r')
        await window.aterm.localTerminal.write(local.id, text.endsWith('\r') ? text : `${text}\r`)
      } else if (hostId && focusedShell) {
        const payload = command.endsWith('\n') ? command : `${command}\n`
        window.aterm.shells.input(hostId, focusedShell.id, payload)
      }
    } catch (error) {
      setFailure({ key: targetKey, message: errorMessage(error) })
    }
  }

  const startNew = (): void => {
    setEditing('new')
    setName('')
    setCmdText('')
  }
  const startEdit = (c: { id: string; name: string; command: string }): void => {
    setEditing({ id: c.id })
    setName(c.name)
    setCmdText(c.command)
  }
  const save = (): void => {
    if (!name.trim() || !cmdText.trim()) return
    if (editing === 'new') addCommand(name, cmdText)
    else if (editing) updateCommand(editing.id, name, cmdText)
    setEditing(null)
  }

  return (
    <div className="flex flex-col gap-2">
      {/* 工具行 */}
      <div className="flex items-center gap-2">
        <Button
          variant="text"
          title={t('activity.commandsAdd')}
          disabled={editing !== null}
          onClick={startNew}
        />
        <div className="flex-1" />
        <span className="text-caption text-muted/60">
          {runnable ? t('activity.commandsRun') : t('activity.commandsNoTarget')}
        </span>
      </div>

      {failure?.key === targetKey && (
        <p role="alert" className="text-minor text-danger">
          {failure.message}
        </p>
      )}

      {/* 内联编辑器（新增/编辑共用） */}
      {editing !== null && (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-raised/40 p-2.5">
          <ATTextField
            value={name}
            onChange={setName}
            placeholder={t('activity.commandsNamePlaceholder')}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
          <ATTextArea
            value={cmdText}
            onChange={setCmdText}
            placeholder={t('activity.commandsCommandPlaceholder')}
            minHeight={64}
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              title={t('common.cancel')}
              size="sm"
              onClick={() => setEditing(null)}
            />
            <Button
              title={t('common.save')}
              size="sm"
              disabled={!name.trim() || !cmdText.trim()}
              onClick={save}
            />
          </div>
        </div>
      )}

      {/* 列表 */}
      {commands.length === 0 && editing === null ? (
        <div className="flex flex-col items-center gap-1.5 py-8 text-center">
          <p className="text-minor text-muted">{t('activity.commandsEmpty')}</p>
          <p className="text-caption text-muted/60">{t('activity.commandsEmptyHint')}</p>
        </div>
      ) : (
        <div className="flex flex-col">
          {commands.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-1 rounded-lg px-1.5 py-1.5 hover:bg-hover/30"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-caption text-fg">{c.name}</div>
                <div className="truncate font-mono text-caption text-muted/75" title={c.command}>
                  {c.command}
                </div>
              </div>
              <IconButton
                icon={Play}
                size={11}
                frame={22}
                aria-label={runnable ? t('activity.commandsRun') : t('activity.commandsNoTarget')}
                disabled={!runnable}
                onClick={() => void run(c.command)}
              />
              <IconButton
                icon={Pencil}
                size={11}
                frame={22}
                aria-label={t('common.edit')}
                onClick={() => startEdit(c)}
              />
              <IconButton
                icon={Trash2}
                size={11}
                frame={22}
                aria-label={t('common.delete')}
                onClick={() => removeCommand(c.id)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
