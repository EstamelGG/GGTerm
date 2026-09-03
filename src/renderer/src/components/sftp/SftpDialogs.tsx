import { Fragment, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { Check, Copy, Folder, Link2, Loader2 } from 'lucide-react'
import type { SftpEntry, SftpMeasureEvent, SftpStat } from '@shared/types'
import { modeOctal, modeString, normalizePath, parseLongname } from '@shared/sftpPath'
import type { SftpGuardHit } from '@shared/sftpPath'
import { cn } from '@/lib/utils'
import { DialogShell } from '@/components/ui/DialogShell'
import { Button } from '@/components/form/Buttons'
import { ATTextField, CheckBox } from '@/components/form/Fields'
import { IconButton } from '@/components/ui/IconButton'
import { fileVisual } from './fileVisual'

/** 单行输入弹窗（mkdir/newFile/rename/moveTo）：目标目录提示（可选）+ ATTextField mono + Cancel/确认 */
export function InputPromptDialog({
  title,
  placeholder,
  initial,
  confirmTitle,
  hint,
  open,
  onConfirm,
  onCancel
}: {
  title: string
  placeholder?: string
  initial?: string
  confirmTitle: string
  /** 目标目录（新建文件/文件夹时显示，防用户不确定创建位置） */
  hint?: string
  open: boolean
  onConfirm: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(initial ?? '')
  const [previous, setPrevious] = useState({ open, initial })
  if (previous.open !== open || previous.initial !== initial) {
    setPrevious({ open, initial })
    if (open) setValue(initial ?? '')
  }
  return (
    <DialogShell
      open={open}
      onOpenChange={(o) => !o && onCancel()}
      title={title}
      width={380}
      footer={
        <>
          <Button variant="ghost" title={t('common.cancel')} onClick={onCancel} />
          <Button
            title={confirmTitle}
            disabled={value.trim() === ''}
            onClick={() => onConfirm(value)}
          />
        </>
      }
    >
      {hint !== undefined && (
        <p className="mb-2 flex items-center gap-1.5 text-caption text-muted">
          <Folder size={12} className="shrink-0" />
          <span className="min-w-0 flex-1 select-text break-all font-mono leading-4">{hint}</span>
        </p>
      )}
      <ATTextField
        className="font-mono"
        value={value}
        onChange={setValue}
        placeholder={placeholder}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim() !== '') onConfirm(value)
        }}
      />
    </DialogShell>
  )
}

/** 权限复选框单元格 */
function PermToggle({
  checked,
  onToggle
}: {
  checked: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="flex items-center justify-center rounded-[4px] p-0.5 outline-none focus-visible:ring-1 focus-visible:ring-at-accent"
      onClick={onToggle}
    >
      <CheckBox state={checked ? 'on' : 'off'} />
    </button>
  )
}

/** 权限编辑弹窗：rwx 复选框矩阵（所有者/群组/其他 × 读/写/执行）+ 特殊位 + 八进制双向同步 */
export function PermissionDialog({
  entry,
  onConfirm,
  onCancel
}: {
  entry: SftpEntry
  onConfirm: (mode: number) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [mode, setMode] = useState(() => (entry.permissions ?? 0) & 0o7777)
  const [octalText, setOctalText] = useState(() =>
    ((entry.permissions ?? 0) & 0o7777).toString(8).padStart(3, '0')
  )

  const toggleBit = (bit: number): void => {
    const next = mode ^ bit
    setMode(next)
    setOctalText(next.toString(8).padStart(3, '0'))
  }

  const onOctalChange = (text: string): void => {
    if (!/^[0-7]{0,4}$/.test(text)) return
    setOctalText(text)
    setMode(text === '' ? 0 : parseInt(text, 8))
  }

  const rows: { label: string; bits: number[] }[] = [
    { label: t('sftp.permRead'), bits: [0o400, 0o040, 0o004] },
    { label: t('sftp.permWrite'), bits: [0o200, 0o020, 0o002] },
    { label: t('sftp.permExecute'), bits: [0o100, 0o010, 0o001] }
  ]
  const specials: { label: string; bit: number }[] = [
    { label: t('sftp.permSetuid'), bit: 0o4000 },
    { label: t('sftp.permSetgid'), bit: 0o2000 },
    { label: t('sftp.permSticky'), bit: 0o1000 }
  ]

  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && onCancel()}
      title={t('sftp.permissions')}
      width={420}
      footer={
        <>
          <Button variant="ghost" title={t('common.cancel')} onClick={onCancel} />
          <Button title={t('common.save')} onClick={() => onConfirm(mode)} />
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-[64px_1fr_1fr_1fr] items-center gap-x-2 gap-y-2">
          <div />
          {[t('sftp.permOwner'), t('sftp.permGroup'), t('sftp.permOthers')].map((label) => (
            <div key={label} className="text-center text-caption text-muted">
              {label}
            </div>
          ))}
          {rows.map((row) => (
            <Fragment key={row.label}>
              <div className="text-caption text-muted">{row.label}</div>
              {row.bits.map((bit) => (
                <div key={bit} className="flex justify-center">
                  <PermToggle checked={(mode & bit) !== 0} onToggle={() => toggleBit(bit)} />
                </div>
              ))}
            </Fragment>
          ))}
        </div>

        <div className="flex items-center gap-4">
          {specials.map((s) => (
            <button
              key={s.bit}
              type="button"
              className="flex items-center gap-1.5 rounded-[4px] outline-none focus-visible:ring-1 focus-visible:ring-at-accent"
              onClick={() => toggleBit(s.bit)}
            >
              <CheckBox state={(mode & s.bit) !== 0 ? 'on' : 'off'} />
              <span className="text-caption text-muted">{s.label}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="shrink-0 text-caption text-muted">{t('sftp.octalHint')}</span>
          <ATTextField
            className="w-24 font-mono"
            value={octalText}
            onChange={onOctalChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onConfirm(mode)
            }}
          />
        </div>
      </div>
    </DialogShell>
  )
}

export type SftpConfirmAction = 'delete' | 'move' | 'rename'

export interface SftpActionPrompt {
  action: SftpConfirmAction
  entries: SftpEntry[]
  subject: string
  detailPaths: string[]
  hits: SftpGuardHit[]
  renameName?: string
  moveDestDir?: string
}

function ConfirmPiece({
  text,
  hitPaths
}: {
  text: string
  hitPaths: Set<string>
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'whitespace-pre-wrap break-all',
        hitPaths.has(normalizePath(text)) ? 'font-semibold text-danger' : 'text-fg'
      )}
    >
      {text}
    </span>
  )
}

/** 危险操作确认（敏感路径红色加粗提示） */
export function ActionConfirmDialog({
  prompt,
  onConfirm,
  onCancel
}: {
  prompt: SftpActionPrompt | null
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (!prompt) return <></>
  const hitPaths = new Set(prompt.hits.map((h) => normalizePath(h.path)))
  const confirmTitle =
    prompt.action === 'delete'
      ? t('common.delete')
      : prompt.action === 'move'
        ? t('sftp.move')
        : t('common.save')
  const title =
    prompt.action === 'delete'
      ? t('common.delete')
      : prompt.action === 'move'
        ? t('sftp.move')
        : t('common.rename')

  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && onCancel()}
      title={title}
      width={420}
      footer={
        <>
          <Button variant="ghost" title={t('common.cancel')} onClick={onCancel} />
          <Button variant="danger" title={confirmTitle} onClick={onConfirm} />
        </>
      }
    >
      <div className="text-body leading-relaxed">
        {prompt.action === 'delete' ? (
          prompt.detailPaths.length <= 1 ? (
            <>
              <ConfirmPiece hitPaths={hitPaths} text={t('sftp.confirmDeletePrefix')} />
              <ConfirmPiece hitPaths={hitPaths} text={prompt.detailPaths[0] ?? prompt.subject} />
              <ConfirmPiece hitPaths={hitPaths} text={t('sftp.questionMark')} />
            </>
          ) : (
            <>
              <ConfirmPiece
                hitPaths={hitPaths}
                text={t('sftp.confirmDeleteMultiple', { count: prompt.detailPaths.length })}
              />
              {prompt.detailPaths.map((p) => (
                <div key={p}>
                  <ConfirmPiece hitPaths={hitPaths} text={p} />
                </div>
              ))}
            </>
          )
        ) : prompt.action === 'move' ? (
          <>
            <ConfirmPiece hitPaths={hitPaths} text={t('sftp.confirmMovePrefix')} />
            <ConfirmPiece hitPaths={hitPaths} text={prompt.subject} />
            <ConfirmPiece hitPaths={hitPaths} text={t('sftp.confirmMoveFrom')} />
            <ConfirmPiece hitPaths={hitPaths} text={prompt.detailPaths[0] ?? ''} />
            <ConfirmPiece hitPaths={hitPaths} text={t('sftp.confirmMoveTo')} />
            <ConfirmPiece hitPaths={hitPaths} text={prompt.detailPaths[1] ?? ''} />
            <ConfirmPiece hitPaths={hitPaths} text={t('sftp.questionMark')} />
          </>
        ) : (
          <>
            <ConfirmPiece hitPaths={hitPaths} text={t('sftp.confirmRenamePrefix')} />
            <ConfirmPiece hitPaths={hitPaths} text={prompt.detailPaths[0] ?? prompt.subject} />
            <ConfirmPiece hitPaths={hitPaths} text={t('sftp.confirmRenameTo')} />
            <ConfirmPiece hitPaths={hitPaths} text={prompt.detailPaths[1] ?? prompt.subject} />
            <ConfirmPiece hitPaths={hitPaths} text={t('sftp.questionMark')} />
          </>
        )}
      </div>
      {prompt.hits.length > 0 && (
        <p className="mt-2 text-caption leading-relaxed text-danger">{t('sftp.guardWarning')}</p>
      )}
    </DialogShell>
  )
}

/** 上传目的地确认 */
export function UploadDestinationDialog({
  summary,
  destPath,
  onConfirm,
  onCancel
}: {
  summary: string
  destPath: string
  onConfirm: (dest: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [dest, setDest] = useState(destPath)
  const [previousPath, setPreviousPath] = useState(destPath)
  if (previousPath !== destPath) {
    setPreviousPath(destPath)
    setDest(destPath)
  }
  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && onCancel()}
      title={t('sftp.uploadTo')}
      width={420}
      footer={
        <>
          <Button variant="ghost" title={t('common.cancel')} onClick={onCancel} />
          <Button
            title={t('common.upload')}
            disabled={dest.trim() === ''}
            onClick={() => onConfirm(dest)}
          />
        </>
      }
    >
      <p className="break-all text-body text-muted">{summary}</p>
      <ATTextField
        className="mt-2 font-mono"
        value={dest}
        onChange={setDest}
        placeholder={t('sftp.destDirHint')}
      />
    </DialogShell>
  )
}

/** 上传冲突（跳过已有 / 替换） */
export function UploadConflictDialog({
  names,
  onCancel,
  onSkip,
  onReplace
}: {
  names: string[]
  onCancel: () => void
  onSkip: () => void
  onReplace: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const first = names[0] ?? ''
  const summary =
    names.length === 1
      ? t('sftp.conflictAskSingle', { name: first })
      : t('sftp.conflictAskMultiple', { name: first, count: names.length })
  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && onCancel()}
      title={t('sftp.uploadConflict')}
      width={400}
      footer={
        <>
          <Button variant="ghost" title={t('common.cancel')} onClick={onCancel} />
          <Button variant="ghost" title={t('sftp.skipExisting')} onClick={onSkip} />
          <Button variant="danger" title={t('sftp.replace')} onClick={onReplace} />
        </>
      }
    >
      <p className="text-body text-muted">{summary}</p>
    </DialogShell>
  )
}

/** 大文件打开拦截：仅提示改走下载，不自动触发（下载由用户点击） */
export function LargeFileDialog({
  entry,
  onDownload,
  onCancel
}: {
  entry: SftpEntry
  onDownload: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const mb = entry.size / (1024 * 1024)
  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && onCancel()}
      title={t('sftp.fileTooLarge')}
      width={420}
      footer={
        <>
          <Button variant="ghost" title={t('common.cancel')} onClick={onCancel} />
          <Button title={t('common.download')} onClick={onDownload} />
        </>
      }
    >
      <div className="text-body leading-relaxed">
        <p className="break-all">
          <span className="font-medium text-fg">{entry.name}</span>
          {t('sftp.tooLargeDetail', { size: mb.toFixed(1), limit: 10 })}
        </p>
        <p className="mt-1 text-muted">{t('sftp.tooLargeHint')}</p>
      </div>
    </DialogShell>
  )
}

/** 详情（基本信息 + 时间 + 目录测量脉冲条可取消） */
export function SftpInfoSheet(props: {
  hostId: string
  entry: SftpEntry
  onClose: () => void
}): React.JSX.Element {
  return <SftpInfoContent key={JSON.stringify([props.hostId, props.entry.path])} {...props} />
}

function SftpInfoContent({
  hostId,
  entry,
  onClose
}: {
  hostId: string
  entry: SftpEntry
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [detail, setDetail] = useState<SftpStat | null>(null)
  const [loading, setLoading] = useState(true)
  /** stat/测量失败（如整目录无权限）：不吞掉整个面板，仅显示在"大小"相关分区 */
  const [sizeError, setSizeError] = useState<string | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [measure, setMeasure] = useState<SftpMeasureEvent | null>(null)

  useEffect(() => {
    let alive = true
    window.aterm.sftp
      .itemDetail(hostId, entry.path)
      .then((d) => alive && setDetail(d))
      .catch((e: Error) => alive && setSizeError(e.message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
      window.aterm.sftp.measureCancel(hostId)
    }
  }, [hostId, entry.path])

  useEffect(() => {
    const off = window.aterm.sftp.onMeasure((e) => {
      if (e.hostId !== hostId || e.path !== entry.path) return
      setMeasure(e)
      if (e.done) setMeasuring(false)
      if (e.error) setSizeError(e.error)
    })
    return off
  }, [hostId, entry.path])

  const parsed = parseLongname(entry.longname)
  const dateLocale = i18next.language.startsWith('zh') ? 'zh-Hans' : 'en-US'
  const fmtDate = (ms: number | null | undefined): string =>
    ms ? new Date(ms).toLocaleString(dateLocale, { dateStyle: 'medium', timeStyle: 'medium' }) : '—'
  const fmtBytes = (n: number): string => {
    if (n < 1024) return `${n} B`
    const units = ['KB', 'MB', 'GB', 'TB']
    let v = n
    let i = -1
    do {
      v /= 1024
      i += 1
    } while (v >= 1024 && i < units.length - 1)
    return `${v.toFixed(1)} ${units[i]}`
  }

  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('sftp.info')}
      width={420}
      contentClassName="p-4 select-text"
    >
      {/* 身份头部：类型图标 + 名称 + 类型/大小副标题（entry 即可渲染，不依赖 stat，加载态也在） */}
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] border border-line/60 bg-raised">
          {entry.isLink ? (
            <Link2 size={20} strokeWidth={1.6} className="text-muted" />
          ) : entry.isDir ? (
            <Folder size={20} strokeWidth={1.5} className="fill-current text-warn" />
          ) : (
            <HeroFileGlyph name={entry.name} />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 pt-0.5">
          <span className="text-title font-semibold break-all text-fg select-text">
            {entry.name}
          </span>
          <span className="text-caption text-muted">
            {entry.isLink
              ? t('sftp.kindLink')
              : entry.isDir
                ? t('sftp.kindDir')
                : `${t('sftp.kindFile')} · ${fmtBytes(entry.size)}`}
          </span>
        </div>
      </div>
      {loading ? (
        <div className="mt-3.5 flex flex-col gap-2.5">
          <div className="h-[76px] animate-pulse rounded-lg bg-raised/55" />
          <div className="h-[92px] animate-pulse rounded-lg bg-raised/55" />
          <div className="h-[56px] animate-pulse rounded-lg bg-raised/55" />
        </div>
      ) : (
        <div className="mt-3.5 flex flex-col gap-3.5">
          {/* 基本信息：路径/链接目标是长文本，独占整行（entry/longname 即可渲染，不依赖 stat） */}
          <InfoSection title={t('sftp.infoBasic')}>
            <CopyRow title={t('sftp.infoPath')} value={entry.path} />
            {entry.linkTarget && (
              <CopyRow title={t('sftp.infoLinkTarget')} value={entry.linkTarget} />
            )}
          </InfoSection>
          {/* 双列紧凑区：属性 | 时间（堆叠式短行，半宽卡片内不挤横向标签列）；stat 失败时属性降级 entry/longname 数据并占满整行 */}
          {detail ? (
            <div className="grid grid-cols-2 gap-3.5">
              <InfoSection title={t('sftp.infoAttrs')}>
                <AttrStack
                  label={t('sftp.permissions')}
                  value={`${modeString(detail.permissions, entry.isDir, entry.isLink)} (${modeOctal(detail.permissions)})`}
                  mono
                />
                <AttrStack
                  label={t('sftp.infoOwner')}
                  value={
                    parsed.owner
                      ? `${parsed.owner}${detail.uid != null ? ` (${detail.uid})` : ''}`
                      : detail.uid != null
                        ? String(detail.uid)
                        : '—'
                  }
                />
                <AttrStack
                  label={t('sftp.infoGroup')}
                  value={
                    parsed.group
                      ? `${parsed.group}${detail.gid != null ? ` (${detail.gid})` : ''}`
                      : detail.gid != null
                        ? String(detail.gid)
                        : '—'
                  }
                />
              </InfoSection>
              <InfoSection title={t('sftp.infoTime')}>
                <AttrStack label={t('sftp.infoAccessed')} value={fmtDate(detail.accessed)} />
                <AttrStack label={t('sftp.infoModified')} value={fmtDate(detail.modified)} />
              </InfoSection>
            </div>
          ) : (
            <InfoSection title={t('sftp.infoAttrs')}>
              <AttrStack
                label={t('sftp.permissions')}
                value={`${modeString(entry.permissions, entry.isDir, entry.isLink)} (${modeOctal(entry.permissions)})`}
                mono
              />
              <AttrStack label={t('sftp.infoOwner')} value={parsed.owner || '—'} />
              <AttrStack label={t('sftp.infoGroup')} value={parsed.group || '—'} />
            </InfoSection>
          )}
          {/* 内容：目录始终渲染；stat 失败（无权限等）→ 报错占位 */}
          {entry.isDir && (
            <InfoSection title={t('sftp.infoContent')}>
              {!detail ? (
                <p className="text-minor leading-relaxed text-danger">
                  {sizeError ?? t('sftp.infoUnavailable')}
                </p>
              ) : (
                <p className="text-body text-fg select-text">
                  {detail.childFiles ?? '—'} {t('sftp.infoFiles')} · {detail.childDirs ?? '—'}{' '}
                  {t('sftp.infoDirs')}
                </p>
              )}
            </InfoSection>
          )}
          {!entry.isDir && (
            <InfoSection title={t('sftp.infoSize')}>
              {sizeError ? (
                <p className="text-minor leading-relaxed text-danger">{sizeError}</p>
              ) : (
                <p className="text-body text-fg select-text">
                  {fmtBytes(detail?.size ?? entry.size)}
                  <span className="ml-2 text-minor text-muted">
                    {(detail?.size ?? entry.size).toLocaleString()} {t('sftp.infoBytes')}
                  </span>
                </p>
              )}
            </InfoSection>
          )}
          {entry.isDir && (
            <InfoSection
              title={t('sftp.infoDirSize')}
              action={
                measuring ? (
                  <>
                    <Loader2 size={12} className="shrink-0 animate-spin text-muted" />
                    <button
                      type="button"
                      className="no-drag shrink-0 cursor-pointer rounded-md text-caption font-medium text-muted outline-none transition-colors duration-150 hover:text-fg focus-visible:ring-[1.5px] focus-visible:ring-at-accent/70"
                      onClick={() => {
                        window.aterm.sftp.measureCancel(hostId)
                        setMeasuring(false)
                        setMeasure(null)
                      }}
                    >
                      {t('common.cancel')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="no-drag shrink-0 cursor-pointer rounded-md text-caption font-medium text-muted outline-none transition-colors duration-150 hover:text-fg focus-visible:ring-[1.5px] focus-visible:ring-at-accent/70"
                    onClick={() => {
                      setMeasure(null)
                      setSizeError(null)
                      setMeasuring(true)
                      window.aterm.sftp.measure(hostId, entry.path)
                    }}
                  >
                    {t('sftp.calculateSize')}
                  </button>
                )
              }
            >
              {detail && sizeError ? (
                <p className="text-minor text-danger">{sizeError}</p>
              ) : (
                <>
                  <MeasureRow
                    title={t('sftp.infoSize')}
                    measuring={measuring}
                    measure={measure}
                    pick={(m) => (m ? fmtBytes(m.bytes) : null)}
                  />
                  <MeasureRow
                    title={t('sftp.infoBytes')}
                    measuring={measuring}
                    measure={measure}
                    pick={(m) => (m ? String(m.bytes) : null)}
                    mono
                  />
                  <MeasureRow
                    title={t('sftp.infoFiles')}
                    measuring={measuring}
                    measure={measure}
                    pick={(m) => (m ? String(m.files) : null)}
                  />
                  <MeasureRow
                    title={t('sftp.infoDirs')}
                    measuring={measuring}
                    measure={measure}
                    pick={(m) => (m ? String(m.dirs) : null)}
                  />
                  {/* 不可读子目录（如 root 属主的 0700 目录）被跳过时的部分结果提示（带目录名样本） */}
                  {!measuring && measure?.done && measure.skipped > 0 && (
                    <p className="pt-0.5 text-caption leading-relaxed text-muted">
                      {measure.skippedPaths.length > 0
                        ? measure.skipped === 1
                          ? t('sftp.measureSkippedOne', { name: measure.skippedPaths[0] })
                          : t('sftp.measureSkippedMany', {
                              name: measure.skippedPaths[0],
                              n: measure.skipped
                            })
                        : t('sftp.measureSkipped', { n: measure.skipped })}
                    </p>
                  )}
                </>
              )}
            </InfoSection>
          )}
          {entry.longname !== '' && (
            <InfoSection title={t('sftp.infoRawList')}>
              <p className="break-all font-mono text-minor text-fg select-text">{entry.longname}</p>
            </InfoSection>
          )}
        </div>
      )}
    </DialogShell>
  )
}

function InfoSection({
  title,
  action,
  children
}: {
  title: string
  /** 分区标题右侧动作（如"目录大小"的 计算大小/取消） */
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-5 items-center gap-2">
        <span className="text-caption font-semibold text-muted">{title}</span>
        <div className="flex-1" />
        {action}
      </div>
      <div className="flex flex-col gap-1.5 rounded-lg border border-line/60 bg-raised/55 p-2.5">
        {children}
      </div>
    </div>
  )
}

/** 身份头图的文件图标：按后缀取语言代表色图标（同文件树），20px 档 */
function HeroFileGlyph({ name }: { name: string }): React.JSX.Element {
  const { icon: Icon, cls } = fileVisual(name)
  return <Icon size={20} strokeWidth={1.5} className={cls} />
}

/** 双列紧凑区的堆叠行：caption 标签在上、值在下（半宽卡片内不挤横向标签列） */
function AttrStack({
  label,
  value,
  mono
}: {
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-caption text-muted">{label}</span>
      <span className={cn('break-all text-minor text-fg select-text', mono && 'font-mono')}>
        {value}
      </span>
    </div>
  )
}

function CopyRow({ title, value }: { title: string; value: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
  return (
    <div className="flex items-start gap-3">
      <span className="w-[72px] shrink-0 text-minor text-muted">{title}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-body text-fg select-text">
        {value}
      </span>
      <IconButton
        icon={copied ? Check : Copy}
        size={12}
        frame={20}
        cornerRadius={4}
        tone="accent"
        className="mt-0.5"
        aria-label={t('common.copy')}
        onClick={() => {
          void navigator.clipboard.writeText(value)
          setCopied(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1000)
        }}
      />
    </div>
  )
}

function MeasureRow({
  title,
  measuring,
  measure,
  pick,
  mono
}: {
  title: string
  measuring: boolean
  measure: SftpMeasureEvent | null
  pick: (m: SftpMeasureEvent) => string | null
  mono?: boolean
}): React.JSX.Element {
  const text = measure ? pick(measure) : null
  return (
    <div className="flex items-center gap-3">
      <span className="w-[72px] shrink-0 text-minor text-muted">{title}</span>
      {text !== null ? (
        <span className={cn('text-body text-fg', mono && 'font-mono')}>{text}</span>
      ) : measuring ? (
        <span
          className="h-2.5 animate-pulse rounded bg-muted/20"
          style={{ width: mono ? 88 : 64 }}
        />
      ) : (
        <span className="text-body text-fg">—</span>
      )}
    </div>
  )
}
