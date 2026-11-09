import { MarqueeText } from '@/components/chrome/MarqueeText'
import { ghostPillCls } from '@/components/form/Buttons'
import { ButtonTooltip } from '@/components/ui/ButtonTooltip'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/utils'
import { useAiStore } from '@/stores/ai'
import { useConnectionsStore } from '@/stores/connections'
import { getToolName } from 'ai'
import type { TFunction } from 'i18next'
import { Check, ChevronRight, FolderOpen, Loader2, ShieldAlert, Wrench, X } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RESPONSE_PAGE,
  responseOf,
  strOf,
  TOOL_ICONS,
  toolSummary,
  type HostResolver,
  type ToolPart
} from './presentation'

/** 源/目的路径行：标签淡化，路径可换行复制 */
function PathRow({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const sep = text.search(/[：:]/)
  const label = sep >= 0 ? text.slice(0, sep + 1) : ''
  const path = sep >= 0 ? text.slice(sep + 1).trim() : text
  return (
    <div className={cn('flex items-start gap-1.5', className)}>
      {label && <span className="shrink-0 text-muted">{label}</span>}
      <span className="min-w-0 whitespace-pre-wrap break-all">{path}</span>
    </div>
  )
}

/** 已拒绝：显式 output-denied，或同一流内自动拒绝后 SDK 落定的 approval-responded(approved=false) */
const isDenied = (p: ToolPart): boolean =>
  p.state === 'output-denied' || (p.state === 'approval-responded' && p.approval.approved === false)

/** 工具块的审批通道：人工（含待确认）/ 自动放行 / 自动拦截；无审批记录返回 null */
function approvalKindOf(p: ToolPart): 'manual' | 'auto' | 'auto-deny' | null {
  // 自动审批请求瞬间也会是 approval-requested，但带 isAutomatic——按自动通道显示，避免黄框闪一下
  if (p.state === 'approval-requested' && p.approval?.isAutomatic) return 'auto'
  if (p.state === 'approval-requested') return 'manual'
  if (!p.approval) return null
  if (!p.approval.isAutomatic) return 'manual'
  return isDenied(p) ? 'auto-deny' : 'auto'
}

/** 是否需要人工点批（自动审批不算待批） */
function needsManualApproval(p: ToolPart): boolean {
  return p.state === 'approval-requested' && !p.approval?.isAutomatic
}

/** 工具块错误文案：执行错误 / 拒绝理由（用户拒绝无理由时用「拒绝」） */
function toolErrorOf(p: ToolPart, t: TFunction): string {
  if (p.state === 'output-error') return p.errorText
  if (isDenied(p)) return p.approval?.reason ?? t('ai.approvalDeny')
  return ''
}

/**
 * 工具卡：整行点击展开；标题（状态 / 工具名@主机 / 描述）；
 * queueWaiting = 同一步仍有未批项，SDK 在全部审批响应齐备后才续跑，故已批准者也先显示「等待」。
 */
export const ToolCallCard = memo(function ToolCallCard({
  part,
  sessionId,
  queueWaiting = false
}: {
  part: ToolPart
  sessionId: string
  /** 已人工批准，但同一步待批未齐，尚未执行 */
  queueWaiting?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const conns = useConnectionsStore((s) => s.connections)

  const respondApproval = useAiStore((s) => s.respondApproval)
  /** 拒绝两段式：null=未进入备注态；''/文本=待提交（备注可留空） */
  const [rejectNote, setRejectNote] = useState<string | null>(null)
  const name = getToolName(part)
  const hostById: HostResolver = (hostId) => {
    const c = conns.find((x) => x.id === hostId)
    return c ? `${c.name} (${c.host})` : hostId
  }
  // 工具入参里的意图描述（execute 的 description 字段，模型填写；其余工具隐藏第二行）
  const desc = strOf(part.input, 'description')
  // 标题主机：入参/输出 hostId，或 execute 按 executionId 反查会话执行记录
  const directHostId = strOf(part.input, 'hostId') || strOf(part.output, 'hostId')
  const executionId = !directHostId && name === 'execute' ? strOf(part.input, 'executionId') : ''
  const [lookup, setLookup] = useState<{ id: string; hostId: string } | null>(null)
  useEffect(() => {
    if (!executionId) return
    let alive = true
    void window.aterm.executions
      .list(sessionId)
      .then((tasks) => {
        const id = tasks.find((t) => t.executionId === executionId)?.hostId ?? ''
        if (alive) setLookup({ id: executionId, hostId: id })
      })
      .catch(() => {
        if (alive) setLookup({ id: executionId, hostId: '' })
      })
    return () => {
      alive = false
    }
  }, [executionId, sessionId])
  const hostId = directHostId || (lookup?.id === executionId ? lookup.hostId : '')
  const hostLabel = hostId ? hostById(hostId) : null
  const summary = toolSummary(name, part.input, part.output, hostById, t)
  const isTransfer = name === 'sftp_download' || name === 'sftp_upload'
  const response = responseOf(name, part.output, t)
  const downloadLocalPath = name === 'sftp_download' ? strOf(part.output, 'localPath') : ''
  const downloadIsDir = (part.output as { isDir?: unknown } | undefined)?.isDir === true
  const responseLines = response !== null ? response.split('\n') : null
  const [visibleLines, setVisibleLines] = useState(RESPONSE_PAGE)
  const hasMore = responseLines !== null && responseLines.length > visibleLines
  const pending = needsManualApproval(part)
  const error = toolErrorOf(part, t)
  // 下载完成后以实际落盘路径为准；完成前使用审批时解析的预计落点。
  const displayPaths = downloadLocalPath
    ? summary
    : (isTransfer && part.approval?.requestReason) || summary
  const summaryLines = isTransfer ? displayPaths.split('\n') : null
  const [open, setOpen] = useState(false)
  // 标题右侧审批通道标签：人工（含待确认）=黄、自动放行=绿、自动拦截=灰；阻塞等待=信息色
  const kind = approvalKindOf(part)
  const kindBadge = queueWaiting
    ? { label: t('ai.approvalWaiting'), cls: 'bg-info/15 text-info' }
    : !kind
      ? null
      : kind === 'manual'
        ? { label: t('ai.approvalManual'), cls: 'bg-warn/15 text-warn' }
        : kind === 'auto'
          ? { label: t('ai.approvalAuto'), cls: 'bg-ok/15 text-ok' }
          : { label: t('ai.approvalAutoDeny'), cls: 'bg-hover text-muted' }
  const status =
    pending || isDenied(part)
      ? { icon: ShieldAlert, cls: 'text-warn' }
      : queueWaiting
        ? { icon: Loader2, cls: 'text-info animate-spin' }
        : part.state === 'output-available'
          ? { icon: Check, cls: 'text-ok' }
          : part.state === 'output-error'
            ? { icon: X, cls: 'text-danger' }
            : { icon: Loader2, cls: 'text-info animate-spin' }
  const StatusIcon = status.icon
  const ToolIcon = TOOL_ICONS[name] ?? Wrench
  return (
    <div
      data-tool-call-id={part.toolCallId}
      data-approval-pending={pending ? '' : undefined}
      className={cn(
        'rounded-md border bg-raised/50 text-minor',
        pending ? 'border-warn/40' : 'border-line'
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-hover/60"
        onClick={() => setOpen((v) => !v)}
      >
        <StatusIcon size={12} strokeWidth={2.2} className={cn('shrink-0', status.cls)} />
        <span className="block min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <ToolIcon size={12} strokeWidth={2.2} className="shrink-0 text-muted" />
            <span className="min-w-0 truncate font-mono text-fg">{name}</span>
            {hostLabel && (
              <span className="min-w-0 truncate text-caption text-muted">@ {hostLabel}</span>
            )}
          </span>
          {desc && (
            <ButtonTooltip label={desc} delayDuration={1000}>
              <MarqueeText text={desc} className="text-caption text-muted" />
            </ButtonTooltip>
          )}
          {error && !open && (
            <span className="mt-0.5 block truncate text-caption text-danger">{error}</span>
          )}
        </span>
        {kindBadge && (
          <span className={cn('shrink-0 rounded px-1 py-0.5 text-caption', kindBadge.cls)}>
            {kindBadge.label}
          </span>
        )}
        <ChevronRight
          size={12}
          strokeWidth={2.4}
          className={cn(
            'shrink-0 text-muted transition-transform duration-150',
            open && 'rotate-90'
          )}
        />
      </button>
      {!open && downloadLocalPath && (
        <div className="flex items-start gap-1.5 border-t border-line/60 px-2.5 py-1.5">
          <PathRow
            text={t('ai.tool.destPath', { path: downloadLocalPath })}
            className="min-w-0 flex-1 select-text font-mono text-caption text-fg/90"
          />
          <IconButton
            icon={FolderOpen}
            tone="accent"
            title={t('ai.tool.openDir')}
            onClick={() => void window.aterm.sftp.revealLocal(downloadLocalPath, downloadIsDir)}
          />
        </div>
      )}
      {open && (displayPaths || response || error) && (
        <div className="border-t border-line/60 px-2.5 py-1.5">
          {displayPaths &&
            (summaryLines ? (
              <div className="select-text font-mono text-caption text-fg/90">
                {summaryLines.map((line, i) =>
                  name === 'sftp_download' && i === 1 ? (
                    <div key={i} className="mt-1 flex items-start gap-1.5">
                      <PathRow text={line} className="min-w-0 flex-1" />
                      {downloadLocalPath && (
                        <IconButton
                          icon={FolderOpen}
                          tone="accent"
                          title={t('ai.tool.openDir')}
                          onClick={() =>
                            void window.aterm.sftp.revealLocal(downloadLocalPath, downloadIsDir)
                          }
                        />
                      )}
                    </div>
                  ) : (
                    <PathRow key={i} text={line} className={i > 0 ? 'mt-1' : ''} />
                  )
                )}
              </div>
            ) : (
              <div className="max-h-40 select-text overflow-y-auto whitespace-pre-wrap break-words font-mono text-caption text-fg/90">
                {displayPaths}
              </div>
            ))}
          {error && (
            <div
              className={cn(
                'select-text whitespace-pre-wrap break-words font-mono text-caption text-danger',
                displayPaths && 'mt-1.5 border-t border-line/60 pt-1.5'
              )}
            >
              {error}
            </div>
          )}
          {!error && response && responseLines && (
            <div className={displayPaths ? 'mt-1.5 border-t border-line/60 pt-1.5' : ''}>
              <div className="mb-0.5 text-caption text-muted">{t('ai.responseTitle')}</div>
              <div className="select-text whitespace-pre-wrap break-words font-mono text-caption text-fg/90">
                {responseLines.slice(0, visibleLines).join('\n')}
              </div>
              {hasMore && (
                <button
                  type="button"
                  onClick={() => setVisibleLines((v) => v + RESPONSE_PAGE)}
                  className="mt-1 cursor-pointer rounded text-caption text-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  {t('ai.showMore')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {needsManualApproval(part) && part.approval && (
        <div className="border-t border-warn/30 px-2.5 py-2">
          {/* 操作参数已在展开区摘要展示，审批区只留操作按钮，避免重复；
              拒绝两段式：先点拒绝（弹备注框），再点提交才生效，备注随拒绝结果回传模型 */}
          <div className="flex gap-2">
            <button
              type="button"
              className={cn(
                ghostPillCls,
                'flex h-6 items-center gap-1 bg-ok/40 px-3 text-minor font-medium text-fg hover:bg-ok/50'
              )}
              onClick={() => {
                setRejectNote(null)
                respondApproval(sessionId, part.approval!.id, true)
              }}
            >
              <Check size={12} strokeWidth={2.4} className="text-ok brightness-150" />
              {t('ai.approvalApprove')}
            </button>
            <button
              type="button"
              className={cn(
                ghostPillCls,
                'flex h-6 items-center gap-1 px-3 text-minor font-medium text-danger hover:bg-hover'
              )}
              onClick={() => {
                if (rejectNote === null) {
                  setRejectNote('')
                  return
                }
                respondApproval(sessionId, part.approval!.id, false, rejectNote.trim() || undefined)
                setRejectNote(null)
              }}
            >
              <X size={12} strokeWidth={2.4} />
              {rejectNote === null ? t('ai.approvalDeny') : t('ai.rejectSubmit')}
            </button>
            {rejectNote !== null && (
              <input
                autoFocus
                value={rejectNote}
                placeholder={t('ai.rejectNotePlaceholder')}
                onChange={(e) => setRejectNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    respondApproval(
                      sessionId,
                      part.approval!.id,
                      false,
                      rejectNote.trim() || undefined
                    )
                    setRejectNote(null)
                  } else if (e.key === 'Escape') {
                    setRejectNote(null)
                  }
                }}
                className="h-6 min-w-0 flex-1 rounded-md border border-line bg-raised px-2 text-caption text-fg placeholder:text-muted/60 outline-none focus:border-at-accent/50"
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
})
