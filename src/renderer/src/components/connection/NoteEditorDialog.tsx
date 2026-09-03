import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NotebookPen, X } from 'lucide-react'
import type { ServerNote } from '@shared/types'
import { errorMessage } from '@shared/error'
import { useConnectionsStore } from '@/stores/connections'
import { Button } from '@/components/form/Buttons'
import { ATNumberField, ATTextArea, ATTextField } from '@/components/form/Fields'
import { DialogShell } from '@/components/ui/DialogShell'
import { IconButton } from '@/components/ui/IconButton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

/**
 * 结构化主机备注编辑器（UI 对照 vscode 版 NoteEditor：加粗 label 垂直表单、
 * 链接式「+ 添加」、方形删除钮、容器勾选显隐子区、meta 名称/主机行）。
 * 保存走 conn:setNote（不打断性能探测/连接状态）；连接表备注列笔记本图标进入，查看与编辑同入口。
 */

/** 字段块：加粗 label 置顶（对照 vscode .field label）；action = 标题右侧的动作（如「+ 添加」） */
function Field({
  label,
  action,
  children
}: {
  label: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-2.5 flex flex-col gap-[3px]">
      <div className="flex items-center gap-2.5">
        <span className="text-body font-semibold text-fg">{label}</span>
        {action}
      </div>
      {children}
    </div>
  )
}

/** 子字段块（容器区内，对照 vscode .sub：label 弱色） */
function SubField({
  label,
  action,
  children
}: {
  label: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-2.5 flex flex-col gap-[3px] pl-1">
      <div className="flex items-center gap-2.5">
        <span className="text-body font-semibold text-muted">{label}</span>
        {action}
      </div>
      {children}
    </div>
  )
}

/** 链接式「+ 添加」按钮（放字段标题右侧） */
function AddRowLink({ title, onClick }: { title: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="py-0.5 text-caption font-medium text-at-accent transition-colors duration-150 hover:underline"
      onClick={onClick}
    >
      + {title}
    </button>
  )
}

/** 动态行列表（网卡/容器/镜像/端口/服务共用）：行 = 输入组 + 方形删除钮；添加入口由字段标题右侧 AddRowLink 承担 */
function DynamicRows<T>({
  rows,
  onChange,
  children
}: {
  rows: T[]
  onChange: (next: T[]) => void
  children: (row: T, setItem: (next: T) => void) => React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5 py-[3px]">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {children(row, (next) => onChange(rows.map((r, idx) => (idx === i ? next : r))))}
          </div>
          <IconButton
            icon={X}
            size={12}
            frame={24}
            cornerRadius={5}
            aria-label="remove row"
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
          />
        </div>
      ))}
    </div>
  )
}

/** 通用行输入（全宽、圆角、13px；等宽档用于 IP/端口/id） */
function RowInput({
  value,
  onChange,
  placeholder,
  mono = false,
  className
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <ATTextField
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={`h-7 min-w-0 flex-1 ${mono ? 'font-mono text-minor' : ''} ${className ?? ''}`}
    />
  )
}

export function NoteEditorDialog({
  hostId,
  hostName,
  hostAddress,
  note,
  onDismiss
}: {
  hostId: string
  hostName: string
  hostAddress: string
  note: ServerNote | undefined
  onDismiss: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const setNote = useConnectionsStore((s) => s.setNote)
  const connections = useConnectionsStore((s) => s.connections)
  const current = connections.find((c) => c.id === hostId)

  const [purpose, setPurpose] = useState(note?.purpose ?? '')
  const [nics, setNics] = useState<string[]>(note?.otherNics?.length ? [...note.otherNics] : [])
  const [internet, setInternet] = useState(
    note?.internetAccess === undefined ? 'unknown' : note.internetAccess ? 'yes' : 'no'
  )
  const [containerMode, setContainerMode] = useState<'unknown' | 'yes' | 'no'>(
    note?.containerEnabled === undefined ? 'unknown' : note.containerEnabled ? 'yes' : 'no'
  )
  const [containers, setContainers] = useState(
    note?.containers?.length ? note.containers.map((c) => ({ ...c })) : []
  )
  const [images, setImages] = useState(
    note?.images?.length ? note.images.map((c) => ({ ...c })) : []
  )
  const [cpuCores, setCpuCores] = useState(note?.cpuCores ?? NaN)
  const [memory, setMemory] = useState(note?.memory ?? '')
  const [disk, setDisk] = useState(note?.disk ?? '')
  const [ports, setPorts] = useState(
    Object.entries(note?.openPorts ?? {}).map(([addr, service]) => ({ addr, service }))
  )
  const [services, setServices] = useState(
    note?.services?.length ? note.services.map((s) => ({ ...s })) : []
  )
  const [other, setOther] = useState(note?.other ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const collect = (): ServerNote => {
    const next: ServerNote = {}
    const p = purpose.trim()
    if (p) next.purpose = p
    const nicList = nics.map((n) => n.trim()).filter(Boolean)
    if (nicList.length) next.otherNics = nicList
    if (internet !== 'unknown') next.internetAccess = internet === 'yes'
    if (containerMode !== 'unknown') {
      next.containerEnabled = containerMode === 'yes'
      if (containerMode === 'yes') {
        const cs = containers.filter((c) => c.id?.trim() || c.name?.trim())
        if (cs.length) next.containers = cs
        const ims = images.filter((c) => c.id?.trim() || c.name?.trim())
        if (ims.length) next.images = ims
      }
    }
    if (Number.isFinite(cpuCores)) next.cpuCores = cpuCores
    if (memory.trim()) next.memory = memory.trim()
    if (disk.trim()) next.disk = disk.trim()
    const portMap: Record<string, string> = {}
    for (const { addr, service } of ports) {
      const a = addr.trim()
      if (a) portMap[a] = service.trim()
    }
    if (Object.keys(portMap).length) next.openPorts = portMap
    const svcList = services
      .map((s) => ({ name: s.name?.trim(), description: s.description?.trim() }))
      .filter((s) => s.name || s.description)
    if (svcList.length) next.services = svcList
    const o = other.trim()
    if (o) next.other = o
    return next
  }

  const save = (): void => {
    setBusy(true)
    setError(null)
    setNote(hostId, collect())
      .then(() => onDismiss())
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setBusy(false))
  }

  /** 回读 store（对照 vscode 刷新按钮：AI/其他入口可能已更新备注） */
  const refresh = (): void => {
    const n = current?.note
    setPurpose(n?.purpose ?? '')
    setNics(n?.otherNics?.length ? [...n.otherNics] : [])
    setInternet(n?.internetAccess === undefined ? 'unknown' : n.internetAccess ? 'yes' : 'no')
    setContainerMode(
      n?.containerEnabled === undefined ? 'unknown' : n.containerEnabled ? 'yes' : 'no'
    )
    setContainers(n?.containers?.length ? n.containers.map((c) => ({ ...c })) : [])
    setImages(n?.images?.length ? n.images.map((c) => ({ ...c })) : [])
    setCpuCores(n?.cpuCores ?? NaN)
    setMemory(n?.memory ?? '')
    setDisk(n?.disk ?? '')
    setPorts(Object.entries(n?.openPorts ?? {}).map(([addr, service]) => ({ addr, service })))
    setServices(n?.services?.length ? n.services.map((s) => ({ ...s })) : [])
    setOther(n?.other ?? '')
  }

  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && !busy && onDismiss()}
      dismissable={!busy}
      title={t('conn.note.title')}
      width={480}
      footerAside={
        <Button variant="text" title={t('common.refresh')} disabled={busy} onClick={refresh} />
      }
      footer={
        <>
          <Button variant="ghost" title={t('common.cancel')} disabled={busy} onClick={onDismiss} />
          <Button title={t('common.save')} disabled={busy} onClick={save} />
        </>
      }
    >
      <div className="flex max-h-[62vh] flex-col overflow-y-auto py-0.5 pr-3">
        {/* meta：名称 / 主机（对照 vscode #meta 表） */}
        <div className="mb-3 flex flex-col gap-0.5 border-b border-line pb-2.5">
          <span className="text-title font-semibold text-fg">{hostName}</span>
          <span className="font-mono text-minor text-muted">{hostAddress}</span>
        </div>

        {error && (
          <p role="alert" className="mb-2 text-body text-danger select-text">
            {error}
          </p>
        )}
        <fieldset disabled={busy} className="flex flex-col">
          <Field label={t('conn.note.purpose')}>
            <ATTextField
              value={purpose}
              onChange={setPurpose}
              placeholder={t('conn.note.purposePh')}
            />
          </Field>

          <Field
            label={t('conn.note.otherNics')}
            action={
              <AddRowLink title={t('conn.note.addNic')} onClick={() => setNics([...nics, ''])} />
            }
          >
            <DynamicRows rows={nics} onChange={setNics}>
              {(row, setItem) => (
                <RowInput value={row} onChange={setItem} placeholder={t('conn.note.ipPh')} mono />
              )}
            </DynamicRows>
          </Field>

          <Field label={t('conn.note.internetAccess')}>
            <Select value={internet} onValueChange={setInternet}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unknown">{t('conn.note.unknown')}</SelectItem>
                <SelectItem value="yes">{t('conn.note.yes')}</SelectItem>
                <SelectItem value="no">{t('conn.note.no')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label={t('conn.note.container')}>
            <Select
              value={containerMode}
              onValueChange={(v) => setContainerMode(v as 'unknown' | 'yes' | 'no')}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unknown">{t('conn.note.unknown')}</SelectItem>
                <SelectItem value="yes">{t('conn.note.yes')}</SelectItem>
                <SelectItem value="no">{t('conn.note.no')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {containerMode === 'yes' && (
            <div className="mb-2.5 ml-3 border-l border-line pl-3">
              <SubField
                label={t('conn.note.containers')}
                action={
                  <AddRowLink
                    title={t('conn.note.addContainer')}
                    onClick={() => setContainers([...containers, { id: '', name: '' }])}
                  />
                }
              >
                <DynamicRows rows={containers} onChange={setContainers}>
                  {(row, setItem) => (
                    <>
                      <RowInput
                        value={row.id ?? ''}
                        onChange={(v) => setItem({ ...row, id: v })}
                        placeholder="id"
                        mono
                      />
                      <RowInput
                        value={row.name ?? ''}
                        onChange={(v) => setItem({ ...row, name: v })}
                        placeholder={t('conn.note.containerName')}
                      />
                    </>
                  )}
                </DynamicRows>
              </SubField>
              <SubField
                label={t('conn.note.images')}
                action={
                  <AddRowLink
                    title={t('conn.note.addImage')}
                    onClick={() => setImages([...images, { id: '', name: '' }])}
                  />
                }
              >
                <DynamicRows rows={images} onChange={setImages}>
                  {(row, setItem) => (
                    <>
                      <RowInput
                        value={row.id ?? ''}
                        onChange={(v) => setItem({ ...row, id: v })}
                        placeholder="id"
                        mono
                      />
                      <RowInput
                        value={row.name ?? ''}
                        onChange={(v) => setItem({ ...row, name: v })}
                        placeholder={t('conn.note.imageName')}
                      />
                    </>
                  )}
                </DynamicRows>
              </SubField>
            </div>
          )}

          {/* 性能三字段独立成行（对照 vscode CPU 核数/内存大小/磁盘大小） */}
          <Field label={t('conn.note.cpuCores')}>
            <ATNumberField value={cpuCores} onChange={setCpuCores} className="w-28" />
          </Field>
          <Field label={t('conn.note.memory')}>
            <ATTextField value={memory} onChange={setMemory} placeholder={t('conn.note.memPh')} />
          </Field>
          <Field label={t('conn.note.disk')}>
            <ATTextField value={disk} onChange={setDisk} placeholder={t('conn.note.diskPh')} />
          </Field>

          <Field
            label={t('conn.note.openPorts')}
            action={
              <AddRowLink
                title={t('conn.note.addPort')}
                onClick={() => setPorts([...ports, { addr: '', service: '' }])}
              />
            }
          >
            <DynamicRows rows={ports} onChange={setPorts}>
              {(row, setItem) => (
                <>
                  <RowInput
                    value={row.addr}
                    onChange={(v) => setItem({ ...row, addr: v })}
                    placeholder="0.0.0.0:8080"
                    mono
                  />
                  <RowInput
                    value={row.service}
                    onChange={(v) => setItem({ ...row, service: v })}
                    placeholder={t('conn.note.serviceName')}
                  />
                </>
              )}
            </DynamicRows>
          </Field>

          <Field
            label={t('conn.note.services')}
            action={
              <AddRowLink
                title={t('conn.note.addService')}
                onClick={() => setServices([...services, { name: '', description: '' }])}
              />
            }
          >
            <DynamicRows rows={services} onChange={setServices}>
              {(row, setItem) => (
                <>
                  <RowInput
                    value={row.name ?? ''}
                    onChange={(v) => setItem({ ...row, name: v })}
                    placeholder={t('conn.note.svcName')}
                  />
                  <RowInput
                    value={row.description ?? ''}
                    onChange={(v) => setItem({ ...row, description: v })}
                    placeholder={t('conn.note.svcDesc')}
                    className="flex-1"
                  />
                </>
              )}
            </DynamicRows>
          </Field>

          <Field label={t('conn.note.other')}>
            <ATTextArea value={other} onChange={setOther} minHeight={64} />
          </Field>
        </fieldset>
      </div>
    </DialogShell>
  )
}

/** 备注编辑入口按钮（连接表备注列；有内容时常亮 accent） */
export function NoteIconButton({
  hasContent,
  onClick
}: {
  hasContent: boolean
  onClick: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <IconButton
      icon={NotebookPen}
      size={12}
      title={t('conn.note.title')}
      tone={hasContent ? 'accent' : 'muted'}
      onClick={onClick}
    />
  )
}
