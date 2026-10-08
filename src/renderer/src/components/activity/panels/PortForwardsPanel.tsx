import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Ellipsis, Pencil, Play, PlugZap, RotateCw, Square, Trash2 } from 'lucide-react'
import type { PortForward, PortForwardAction, PortForwardInput } from '@shared/portForward'
import { endpoint } from '@shared/portForward'
import { errorMessage } from '@shared/error'
import { useConnectionsStore } from '@/stores/connections'
import { usePortForwardsStore } from '@/stores/portForwards'
import { Button, ATField } from '@/components/form/Buttons'
import { ATNumberField, ATTextField } from '@/components/form/Fields'
import { IconButton } from '@/components/ui/IconButton'
import { DialogShell } from '@/components/ui/DialogShell'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

const active = (rule: PortForward): boolean => !['stopped', 'error'].includes(rule.status)
const bytes = (value: number): string =>
  value < 1024
    ? `${value} B`
    : value < 1048576
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1048576).toFixed(1)} MB`

async function startForward(rule: PortForward): Promise<void> {
  // SSH 建连由主进程完成，不创建主机工作区或终端标签。
  await window.aterm.portForwards.control(rule.id, 'start')
}

function ForwardRow({
  rule,
  hostName,
  missingHost
}: {
  rule: PortForward
  hostName: string
  missingHost: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const edit = usePortForwardsStore((s) => s.edit)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await work()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const control = (action: PortForwardAction): void => {
    void run(async () => {
      if (action === 'start') await startForward(rule)
      else await window.aterm.portForwards.control(rule.id, action)
    })
  }
  return (
    <div
      className={cn(
        'min-w-0 rounded-lg border p-3 transition-colors duration-150',
        missingHost
          ? 'border-danger/30 bg-danger/10 hover:border-danger/50'
          : 'border-line bg-raised/40 hover:border-chrome-sep'
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            missingHost
              ? 'bg-danger'
              : rule.status === 'running'
                ? 'bg-ok'
                : rule.status === 'error'
                  ? 'bg-danger'
                  : active(rule)
                    ? 'bg-at-accent'
                    : 'bg-muted'
          )}
        />
        <span className="min-w-0 flex-1 truncate text-body font-medium text-fg" title={rule.name}>
          {rule.name}
        </span>
        {missingHost && (
          <span className="shrink-0 text-caption font-medium text-danger">
            {t('forward.hostDeleted')}
          </span>
        )}
        <IconButton
          icon={active(rule) ? Square : Play}
          title={t(active(rule) ? 'forward.stopHint' : 'forward.start')}
          aria-label={t(active(rule) ? 'forward.stop' : 'forward.start')}
          className={
            active(rule)
              ? 'bg-danger/10 text-danger hover:bg-danger/20 hover:text-danger'
              : 'bg-ok/10 text-ok hover:bg-ok/20 hover:text-ok'
          }
          disabled={busy || (missingHost && !active(rule))}
          onClick={() => control(active(rule) ? 'stop' : 'start')}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton icon={Ellipsis} title={t('common.moreActions')} disabled={busy} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={active(rule)} onClick={() => edit(rule)}>
              <Pencil />
              {t('common.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                void run(async () => {
                  await navigator.clipboard.writeText(endpoint(rule.listenAddress, rule.listenPort))
                  setMessage(t('common.copied'))
                })
              }
            >
              <Copy />
              {t('forward.copy')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={missingHost} onClick={() => control('restart')}>
              <RotateCw />
              {t('forward.restart')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                void run(async () => {
                  const copy = await window.aterm.portForwards.configure({
                    ...rule,
                    name: `${rule.name} - Copy`,
                    startPolicy: 'manual'
                  })
                  edit(copy)
                })
              }
            >
              <Copy />
              {t('forward.duplicate')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                void run(async () => {
                  const result = await window.aterm.portForwards.probe(rule.id)
                  if (result.reachable) setMessage(t('forward.reachable', { ms: result.latencyMs }))
                  else setError(t('forward.unreachable', { error: result.error ?? '' }))
                })
              }
            >
              <PlugZap />
              {t('forward.probe')}
            </DropdownMenuItem>
            {rule.owner === 'agent' && (
              <DropdownMenuItem onClick={() => control('adopt')}>
                {t('forward.adopt')}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
              <Trash2 />
              {t('common.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 text-caption text-muted">
        <span>
          {t(rule.type === 'local' ? 'forward.local' : 'forward.remote')} · {hostName}
        </span>
        <span>{t(`forward.status.${rule.status}`)}</span>
        <span title={rule.sessionId}>
          {t(rule.owner === 'agent' ? 'forward.agent' : 'forward.user')}
        </span>
      </div>
      <div className="mt-2 min-w-0 space-y-1 text-minor text-fg">
        <div className="flex gap-2">
          <span className="shrink-0 text-muted">
            {t(rule.type === 'local' ? 'forward.localSide' : 'forward.remoteSide')}
          </span>
          <span
            className="truncate font-mono"
            title={endpoint(rule.listenAddress, rule.listenPort)}
          >
            {endpoint(rule.listenAddress, rule.listenPort)}
          </span>
        </div>
        <div className="flex gap-2">
          <span className="shrink-0 text-muted">
            → {t(rule.type === 'local' ? 'forward.remoteSide' : 'forward.localSide')}
          </span>
          <span className="truncate font-mono" title={endpoint(rule.targetHost, rule.targetPort)}>
            {endpoint(rule.targetHost, rule.targetPort)}
          </span>
        </div>
      </div>
      {rule.status === 'running' && (
        <div className="mt-2 flex flex-wrap gap-2 text-caption text-muted">
          <span>{t('forward.connections', { count: rule.connections })}</span>
          <span className="font-mono">
            ↑ {bytes(rule.bytesUp)} · ↓ {bytes(rule.bytesDown)}
          </span>
        </div>
      )}
      {(error || rule.error) && (
        <p role="alert" className="mt-2 break-words text-minor text-danger">
          {error || rule.error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-2 text-minor text-ok">
          {message}
        </p>
      )}
      <DialogShell
        open={deleting}
        onOpenChange={setDeleting}
        title={t('forward.deleteTitle')}
        footer={
          <>
            <Button
              variant="ghost"
              title={t('common.cancel')}
              disabled={busy}
              onClick={() => setDeleting(false)}
            />
            <Button
              variant="danger"
              title={t('common.delete')}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await window.aterm.portForwards.control(rule.id, 'delete')
                  setDeleting(false)
                })
              }
            />
          </>
        }
      >
        <p className="p-4 text-body text-fg">{t('forward.deleteHint')}</p>
      </DialogShell>
    </div>
  )
}

function ForwardEditor({
  hostId,
  rule
}: {
  hostId: string
  rule?: PortForward
}): React.JSX.Element {
  const { t } = useTranslation()
  const hosts = useConnectionsStore((s) => s.connections)
  const close = usePortForwardsStore((s) => s.closeEditor)
  const [id, setId] = useState(rule?.id)
  const [input, setInput] = useState<PortForwardInput>(
    rule ?? {
      name: '',
      hostId: hostId || hosts[0]?.id || '',
      type: 'local',
      listenAddress: '127.0.0.1',
      listenPort: 8080,
      targetHost: '127.0.0.1',
      targetPort: 80,
      startPolicy: 'manual'
    }
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = <K extends keyof PortForwardInput>(key: K, value: PortForwardInput[K]): void =>
    setInput((prev) => ({ ...prev, [key]: value }))
  const save = async (start: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const saved = await window.aterm.portForwards.configure(input, id)
      setId(saved.id)
      if (start) await startForward(saved)
      close()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const select = (
    value: string,
    onChange: (v: string) => void,
    options: Array<{ value: string; label: string }>
  ): React.JSX.Element => (
    <Select value={value} onValueChange={onChange} disabled={busy}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
      dismissable={!busy}
      title={t(rule ? 'forward.edit' : 'forward.new')}
      width={460}
      footer={
        <>
          <Button
            variant="ghost"
            title={t('common.save')}
            disabled={busy || !input.hostId}
            onClick={() => void save(false)}
          />
          <Button
            title={t('forward.saveStart')}
            disabled={busy || !input.hostId}
            onClick={() => void save(true)}
          />
        </>
      }
    >
      <div className="space-y-4 p-4">
        <ATField title={t('forward.name')}>
          <ATTextField value={input.name} onChange={(v) => set('name', v)} disabled={busy} />
        </ATField>
        <ATField title={t('forward.host')} required>
          {select(
            input.hostId,
            (v) => set('hostId', v),
            hosts.map((h) => ({ value: h.id, label: `${h.name} · ${h.host}` }))
          )}
        </ATField>
        <ATField title={t('forward.type')}>
          {select(input.type, (v) => set('type', v as PortForwardInput['type']), [
            { value: 'local', label: t('forward.local') },
            { value: 'remote', label: t('forward.remote') }
          ])}
        </ATField>
        <ATField title={t(input.type === 'local' ? 'forward.localListen' : 'forward.remoteListen')}>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <ATTextField
                value={input.listenAddress}
                onChange={(v) => set('listenAddress', v)}
                className="font-mono"
                disabled={busy}
              />
            </div>
            <div className="w-24">
              <ATNumberField
                value={input.listenPort}
                onChange={(v) => set('listenPort', v)}
                className="font-mono"
                disabled={busy}
              />
            </div>
          </div>
        </ATField>
        <ATField title={t(input.type === 'local' ? 'forward.remoteTarget' : 'forward.localTarget')}>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <ATTextField
                value={input.targetHost}
                onChange={(v) => set('targetHost', v)}
                className="font-mono"
                disabled={busy}
              />
            </div>
            <div className="w-24">
              <ATNumberField
                value={input.targetPort}
                onChange={(v) => set('targetPort', v)}
                className="font-mono"
                disabled={busy}
              />
            </div>
          </div>
        </ATField>
        {rule?.owner !== 'agent' && (
          <ATField title={t('forward.policy')}>
            {select(
              input.startPolicy,
              (v) => set('startPolicy', v as PortForwardInput['startPolicy']),
              [
                { value: 'manual', label: t('forward.manual') },
                { value: 'on-connect', label: t('forward.onConnect') }
              ]
            )}
          </ATField>
        )}
        <p className="text-minor text-muted">
          {t(input.type === 'local' ? 'forward.previewLocal' : 'forward.previewRemote', {
            listen: endpoint(input.listenAddress, input.listenPort),
            target: endpoint(input.targetHost, input.targetPort),
            host: hosts.find((h) => h.id === input.hostId)?.name ?? ''
          })}
        </p>
        {!['127.0.0.1', '::1'].includes(input.listenAddress) && (
          <p className="text-minor text-at-accent">{t('forward.exposure')}</p>
        )}
        {error && (
          <p role="alert" className="break-words text-minor text-danger">
            {error}
          </p>
        )}
      </div>
    </DialogShell>
  )
}

export function PortForwardsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const rules = usePortForwardsStore((s) => s.rules)
  const filter = usePortForwardsStore((s) => s.filterHostId)
  const setFilter = usePortForwardsStore((s) => s.setFilter)
  const editor = usePortForwardsStore((s) => s.editor)
  const open = usePortForwardsStore((s) => s.open)
  const hosts = useConnectionsStore((s) => s.connections)
  const visible = rules.filter((r) => !filter || r.hostId === filter)
  const hostsLoaded = useConnectionsStore((s) => s.loaded)
  return (
    <>
      <Select value={filter || 'all'} onValueChange={(v) => setFilter(v === 'all' ? '' : v)}>
        <SelectTrigger className="w-full" aria-label={t('forward.host')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('forward.allHosts')}</SelectItem>
          {filter && hostsLoaded && !hosts.some((h) => h.id === filter) && (
            <SelectItem value={filter}>{t('forward.hostDeleted')}</SelectItem>
          )}
          {hosts.map((h) => (
            <SelectItem key={h.id} value={h.id}>
              {h.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {visible.length ? (
        <div className="mt-3 space-y-3">
          {visible.map((rule) => (
            <ForwardRow
              key={rule.id}
              rule={rule}
              hostName={hosts.find((h) => h.id === rule.hostId)?.name ?? rule.hostId}
              missingHost={hostsLoaded && !hosts.some((h) => h.id === rule.hostId)}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-3 py-8 text-center">
          <p className="text-body text-fg">{t('forward.empty')}</p>
          <p className="text-minor text-muted">{t('forward.emptyHint')}</p>
          <Button
            title={t('forward.new')}
            disabled={!hosts.length}
            onClick={() => open(filter, true)}
          />
        </div>
      )}
      {editor && (
        <ForwardEditor
          key={editor.rule?.id ?? `new:${editor.hostId}`}
          hostId={editor.hostId}
          rule={editor.rule}
        />
      )}
    </>
  )
}
