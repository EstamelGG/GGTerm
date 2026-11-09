import { BrowserReferenceChip } from '@/components/ai/BrowserReferenceChip'
import { FileReferenceChip } from '@/components/ai/FileReferenceChip'
import { Markdown } from '@/components/ai/Markdown'
import { ghostPillCls } from '@/components/form/Buttons'
import { cn } from '@/lib/utils'
import {
  DOT_TOP_TEXT,
  DOT_TOP_THINKING,
  DOT_TOP_TOOL,
  TEXT_DOT,
  THINKING_DOT,
  TimelineNode
} from '@/pages/aiTimeline'
import { toolDotCls } from '@/pages/toolDotCls'
import { textOf, useAiStore } from '@/stores/ai'
import type { AiUIMessage } from '@shared/types'
import type { ReasoningUIPart } from 'ai'
import { isToolUIPart } from 'ai'
import { Brain, CheckCheck, ChevronRight, Loader2, Server, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ToolPart } from './presentation'
import { ToolCallCard } from './ToolCallCard'

/** 思考块：默认折叠；折叠行走马灯滚动显示最新思考内容（尾部预览）；手动展开看全文 */
function ThinkingBlock({ part }: { part: ReasoningUIPart }): React.JSX.Element {
  const { t } = useTranslation()
  const running = part.state === 'streaming'
  const [open, setOpen] = useState(false)
  // 折叠行预览：压平空白后取尾部（最新内容），静态截断展示
  const preview = part.text.replace(/\s+/g, ' ').trim().slice(-160)
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 text-left text-caption text-muted transition-colors hover:text-fg"
        onClick={() => setOpen(!open)}
      >
        {running ? (
          <Loader2 size={11} className="shrink-0 animate-spin" />
        ) : (
          <Brain size={11} className="shrink-0" />
        )}
        <span className="shrink-0">
          {running ? t('ai.thinkingRunning') : t('ai.thinkingTitle')}
        </span>
        {!open && preview ? (
          <span className="min-w-0 flex-1 truncate text-muted/70">{preview}</span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <ChevronRight
          size={11}
          strokeWidth={2.4}
          className={cn('shrink-0 transition-transform duration-150', open && 'rotate-90')}
        />
      </button>
      {open && (
        <div className="mt-1 max-h-40 select-text overflow-y-auto [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Markdown muted>{running ? `${part.text}▍` : part.text}</Markdown>
        </div>
      )}
    </div>
  )
}

/** 用户消息里的 @主机 token 高亮（payload 拼接见 lib/aiInput） */
function highlightMentions(text: string): ReactNode[] {
  return text.split(/(@[^\s@]+)/g).map((seg, i) =>
    seg.startsWith('@') ? (
      <span key={i} className="rounded bg-info/20 px-0.5 text-info">
        {seg}
      </span>
    ) : (
      <span key={i}>{seg}</span>
    )
  )
}

/** 消息时间戳：本机时区；同年省略年份，跨年带年份 */
function formatTimestamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  const date = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  return d.getFullYear() === new Date().getFullYear() ? date : `${d.getFullYear()}-${date}`
}

type Part = AiUIMessage['parts'][number]
/** 可渲染块：思考 / 正文 / 工具（step-start 等结构块不渲染） */
const isRenderable = (p: Part): boolean =>
  p.type === 'text' || p.type === 'reasoning' || isToolUIPart(p)
type PendingToolPart = Extract<ToolPart, { state: 'approval-requested' }>
const isPendingTool = (p: Part): p is PendingToolPart =>
  isToolUIPart(p) && p.state === 'approval-requested' && !p.approval?.isAutomatic

/** 已批准但仍卡在审批态（等前序齐批后续跑） */
const isApprovalHeld = (p: Part): boolean =>
  isToolUIPart(p) && p.state === 'approval-responded' && p.approval.approved === true

/** memo：其他消息/会话级更新时，引用未变化的消息整棵子树跳过重渲染 */
export const MessageItem = memo(function MessageItem({
  m,
  sessionId
}: {
  m: AiUIMessage
  sessionId: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const respondApproval = useAiStore((s) => s.respondApproval)
  const createdAt = m.metadata?.createdAt
  const stamp = createdAt ? (
    <span className="text-caption text-muted/70">{formatTimestamp(createdAt)}</span>
  ) : null
  if (m.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
        {stamp}
        {m.metadata?.browserReferences?.map((reference) => (
          <BrowserReferenceChip key={reference.id} reference={reference} />
        ))}
        {m.metadata?.fileReferences?.map((file) => (
          <FileReferenceChip key={JSON.stringify([file.hostId, file.path])} file={file} />
        ))}
        {m.metadata?.hostReferences?.map((host) => (
          <span
            key={host.id}
            title={`${host.host}:${host.port}`}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-raised px-2 py-1 text-caption"
          >
            <Server size={12} />
            <span className="truncate">{host.name}</span>
          </span>
        ))}
        <div className="max-w-[85%] select-text break-words rounded-lg bg-at-accent/15 px-3 py-2 text-body text-fg [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Markdown decorator={highlightMentions}>{textOf(m)}</Markdown>
        </div>
      </div>
    )
  }
  // 一个回合 = 一条步骤时间线：思考/正文/工具卡同级挂在轴上、按真实发生顺序排列
  const parts = m.parts.filter(isRenderable)
  const lastIdx = parts.length - 1
  // 同一步仍有人工待批时，已批准的卡显示「等待」（齐批前不会执行）
  const approvalBlocked = parts.some(isPendingTool)
  const renderPart = (p: Part, i: number): ReactNode => {
    const first = i === 0
    const last = i === lastIdx
    if (p.type === 'reasoning')
      return (
        <TimelineNode
          key={i}
          dotCls={THINKING_DOT}
          dotTop={DOT_TOP_THINKING}
          first={first}
          last={last}
        >
          <ThinkingBlock part={p} />
        </TimelineNode>
      )
    if (p.type === 'text') {
      if (!p.text) return null
      return (
        <TimelineNode key={i} dotCls={TEXT_DOT} dotTop={DOT_TOP_TEXT} first={first} last={last}>
          <div className="select-text text-body text-fg">
            <Markdown>{p.state === 'streaming' ? `${p.text}▍` : p.text}</Markdown>
          </div>
        </TimelineNode>
      )
    }
    if (!isToolUIPart(p)) return null
    return (
      <TimelineNode
        key={p.toolCallId}
        dotCls={toolDotCls(p)}
        dotTop={DOT_TOP_TOOL}
        first={first}
        last={last}
      >
        <ToolCallCard
          part={p}
          sessionId={sessionId}
          queueWaiting={approvalBlocked && isApprovalHeld(p)}
        />
      </TimelineNode>
    )
  }
  // 连续 ≥3 张待审批工具卡自动成组：warn 外框放在时间线圆点右侧，底部黄色操作条提供批量出口
  const rendered: ReactNode[] = []
  let i = 0
  while (i < parts.length) {
    if (isPendingTool(parts[i])) {
      let j = i
      while (j < parts.length && isPendingTool(parts[j])) j++
      if (j - i >= 3) {
        const run = parts.slice(i, j).filter(isPendingTool)
        const respondAll = (approved: boolean): void =>
          run.forEach((p) => respondApproval(sessionId, p.approval.id, approved))
        rendered.push(
          <TimelineNode
            key={`approval-group-${i}`}
            dotCls="bg-warn animate-pulse"
            dotTop={DOT_TOP_TOOL}
            first={i === 0}
            last={j - 1 === lastIdx}
          >
            <div className="flex flex-col gap-1.5 rounded-lg border border-warn/40 p-1.5">
              {run.map((p) => (
                <ToolCallCard key={p.toolCallId} part={p} sessionId={sessionId} />
              ))}
              {/* 底部批量操作条：黄色填充；同意在左（绿色双对勾），拒绝在右（红色叉） */}
              <div className="flex items-center justify-end gap-2 rounded-md bg-warn/10 px-2 py-1.5">
                <button
                  type="button"
                  className={cn(
                    ghostPillCls,
                    'flex h-6 items-center gap-1 bg-ok/40 px-3 text-minor font-medium text-fg hover:bg-ok/50'
                  )}
                  onClick={() => respondAll(true)}
                >
                  <CheckCheck size={12} strokeWidth={2.4} className="text-ok brightness-150" />
                  {t('ai.approvalApproveAll')}
                </button>
                <button
                  type="button"
                  className={cn(
                    ghostPillCls,
                    'flex h-6 items-center gap-1 px-3 text-minor font-medium text-danger hover:bg-hover'
                  )}
                  onClick={() => respondAll(false)}
                >
                  <X size={12} strokeWidth={2.4} />
                  {t('ai.approvalDenyAll')}
                </button>
              </div>
            </div>
          </TimelineNode>
        )
        i = j
        continue
      }
    }
    rendered.push(renderPart(parts[i], i))
    i++
  }
  return (
    <div className="flex flex-col gap-1">
      {stamp}
      <div className="flex flex-col">{rendered}</div>
      {m.metadata?.interrupted && <p className="text-caption text-muted">{t('ai.interrupted')}</p>}
      {m.metadata?.contextCompressed && (
        <p className="text-caption text-muted">{t('ai.contextCompressed')}</p>
      )}
      {m.metadata?.finishReason === 'step-limit' && (
        <p className="text-caption text-muted">{t('ai.stepLimit')}</p>
      )}
      {m.metadata?.finishReason === 'length' && (
        <p className="text-caption text-muted">{t('ai.outputLimit')}</p>
      )}
      {m.metadata?.error && (
        <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-body text-danger">
          {m.metadata.error}
        </div>
      )}
    </div>
  )
})
