import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound } from 'lucide-react'
import type { SshConfigHost } from '@shared/types'
import { errorMessage } from '@shared/error'
import { useConnectionsStore } from '@/stores/connections'
import { Button } from '@/components/form/Buttons'
import { CheckBox } from '@/components/form/Fields'
import { DialogShell } from '@/components/ui/DialogShell'

/**
 * ~/.ssh/config 导入弹窗：解析 config → 勾选别名 → 批量建连接。
 * IdentityFile 可读则入凭据（authType=privateKey）；无密钥/读取失败退回 manual，
 * 连接时自动触发手动登录流程（可勾选"保存密码"升级为密码模式）。
 */
export function SshConfigImport({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const create = useConnectionsStore((s) => s.create)
  const connections = useConnectionsStore((s) => s.connections)

  const [entries, setEntries] = useState<SshConfigHost[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const canceled = useRef(false)
  const [completed, setCompleted] = useState(new Set<string>())
  const [canceling, setCanceling] = useState(false)
  const requestCancel = (): void => {
    if (!busy) onDone()
    else {
      canceled.current = true
      setCanceling(true)
    }
  }

  // 已存在判定（host:port 同键）：默认不勾 + 行尾"已添加"徽标共用
  const existing = useMemo(
    () => new Set(connections.map((c) => `${c.host}:${c.port}`)),
    [connections]
  )

  useEffect(() => {
    let alive = true
    window.aterm.localSsh
      .parseConfig()
      .then((list) => {
        if (!alive) return
        setEntries(list)
        // 已有同 host 的默认不勾，其余全勾
        const existing = new Set(
          useConnectionsStore.getState().connections.map((c) => `${c.host}:${c.port}`)
        )
        setChecked(
          new Set(list.filter((e) => !existing.has(`${e.host}:${e.port}`)).map((e) => e.alias))
        )
      })
      .catch((err) => alive && setError(errorMessage(err)))
    return () => {
      alive = false
      canceled.current = true
    }
  }, [])

  const toggle = (alias: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(alias)) next.delete(alias)
      else next.add(alias)
      return next
    })
  }

  const setAll = (v: boolean): void =>
    setChecked(v ? new Set((entries ?? []).map((e) => e.alias)) : new Set())

  /** 只选未添加的（与默认勾选、"已添加"徽标同一判定：host:port 已存在） */
  const selectMissing = (): void =>
    setChecked(
      new Set(
        (entries ?? []).filter((e) => !existing.has(`${e.host}:${e.port}`)).map((e) => e.alias)
      )
    )

  const run = (): void => {
    if (entries === null || busy) return
    setBusy(true)
    setError(null)
    canceled.current = false
    setCanceling(false)
    void (async () => {
      try {
        for (const e of entries) {
          if (canceled.current) break
          if (!checked.has(e.alias) || completed.has(e.alias)) continue
          let privateKey = ''
          if (e.identityFile) {
            try {
              privateKey = await window.aterm.localSsh.readKey(e.identityFile)
            } catch {
              privateKey = '' // 密钥读不了 → manual，连接时手动登录
            }
          }
          if (canceled.current) break
          await create(
            {
              name: e.alias,
              host: e.host,
              port: e.port,
              username: e.user,
              authType: privateKey ? 'privateKey' : 'manual',
              groupId: null
            },
            { password: '', privateKey, passphrase: '' }
          )
          setCompleted((previous) => new Set(previous).add(e.alias))
          setChecked((previous) => {
            const next = new Set(previous)
            next.delete(e.alias)
            return next
          })
        }
        onDone()
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        setBusy(false)
        setCanceling(false)
      }
    })()
  }

  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && requestCancel()}
      title={t('conn.importTitle')}
      width={460}
      contentClassName="p-0"
      footer={
        <>
          <Button
            variant="ghost"
            title={t(canceling ? 'common.canceling' : 'common.cancel')}
            disabled={canceling}
            onClick={requestCancel}
          />
          <Button
            title={t('conn.importRun', { n: checked.size })}
            disabled={checked.size === 0 || busy}
            onClick={run}
          />
        </>
      }
    >
      {/* 快捷选择栏（Button）；有可导入条目才显示 */}
      {entries !== null && entries.length > 0 && (
        <div className="flex items-center justify-end gap-1.5 border-b border-line px-3.5 py-2">
          <Button
            variant="text"
            title={t('conn.selectAll')}
            disabled={busy}
            onClick={() => setAll(true)}
          />
          <Button
            variant="text"
            title={t('conn.deselectAll')}
            disabled={busy}
            onClick={() => setAll(false)}
          />
          <Button
            variant="text"
            title={t('conn.importSelectDefault')}
            disabled={busy}
            onClick={selectMissing}
          />
        </div>
      )}

      <div className="max-h-[50vh] min-h-[160px] overflow-y-auto p-3.5">
        {error ? (
          <p className="py-8 text-center text-body text-danger">{error}</p>
        ) : entries === null ? (
          <p className="py-8 text-center text-body text-muted">{t('conn.importReading')}</p>
        ) : entries.length === 0 ? (
          <p className="py-8 text-center text-body text-muted">{t('conn.importEmpty')}</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {entries.map((e) => (
              <button
                key={e.alias}
                disabled={busy || completed.has(e.alias)}
                type="button"
                className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-hover/60"
                onClick={() => toggle(e.alias)}
              >
                <CheckBox state={checked.has(e.alias) ? 'on' : 'off'} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-body font-medium text-fg">{e.alias}</span>
                  <span className="truncate text-caption text-muted">
                    {e.user}@{e.host}:{e.port}
                  </span>
                </span>
                {e.identityFile && (
                  <KeyRound
                    size={11}
                    strokeWidth={2}
                    className="shrink-0 text-at-accent/80"
                    aria-label="key"
                  />
                )}
                {existing.has(`${e.host}:${e.port}`) && (
                  <span className="shrink-0 rounded-full bg-hover/60 px-2 py-[2px] text-caption text-muted">
                    {t('conn.importExisting')}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </DialogShell>
  )
}
