import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip } from 'radix-ui'
import type { PerfSample } from '@shared/types'
import { cn } from '@/lib/utils'
import { CopyIconButton } from '@/components/ui/IconButton'
import type { LatencyStatus } from '@/stores/latency'

/**
 * 单行截断文本 + 悬浮气泡：仅真正溢出省略时，悬停 0.5s 弹出完整内容。
 * 自控延时（原生 title 延迟不可调）；radix Portal 定位，避免被表格滚动容器裁剪。
 */
function TruncatedCellText({
  text,
  className
}: {
  text: string
  className?: string
}): React.JSX.Element {
  const spanRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [tip, setTip] = useState<string | null>(null)
  const cancel = (): void => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    setTip(null)
  }
  return (
    <Tooltip.Provider>
      {/* open 全受控：radix 自身的延时/开启意图被吞掉，唯一开启路径 = 溢出 + 0.5s 计时 */}
      <Tooltip.Root open={tip !== null}>
        <Tooltip.Trigger asChild>
          <span
            ref={spanRef}
            className={className}
            onMouseEnter={() => {
              const el = spanRef.current
              if (!el || el.scrollWidth <= el.clientWidth) return
              timerRef.current = setTimeout(() => setTip(text), 500)
            }}
            onMouseLeave={cancel}
            onBlur={cancel}
          >
            {text}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            sideOffset={4}
            className="pointer-events-none z-[100] max-w-96 rounded-md border border-line bg-raised px-2 py-1 text-minor text-fg shadow-md"
          >
            {tip}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}

/** 对照 HostAddressCell：等宽主机文本 + 复制按钮（accent 常驻；成功变对勾 1s）；溢出省略时悬停看全文 */
export function HostAddressCell({
  text,
  onCopy
}: {
  text: string
  onCopy: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-6 min-w-0 items-center gap-1">
      <TruncatedCellText
        text={text}
        className="min-w-0 flex-1 truncate font-mono text-minor text-muted"
      />
      <CopyIconButton value={text} label={t('conn.copyAddress')} onCopied={onCopy} />
    </div>
  )
}

/** 对照 ExpandableTextCell：单行截断文本（超长截断，溢出省略时悬停显示完整内容） */
export function ExpandableTextCell({
  text,
  weight = 'regular',
  className
}: {
  text: string
  weight?: 'regular' | 'medium'
  className?: string
}): React.JSX.Element {
  if (text === '') {
    return <span className="block min-w-0 truncate text-body text-muted">&nbsp;</span>
  }

  return (
    <TruncatedCellText
      text={text}
      className={cn(
        'block min-w-0 w-full truncate text-body text-muted',
        weight === 'medium' && 'font-medium text-fg',
        className
      )}
    />
  )
}

/** 滚筒单数字位：0-9 纵向排布，值变化时 translateY 平滑滚到新位（里程表效果） */
function OdometerDigit({ digit }: { digit: string }): React.JSX.Element {
  const idx = Number(digit)
  return (
    <span className="inline-block h-[1.25em] overflow-hidden">
      <span
        className="flex flex-col transition-transform duration-[350ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ transform: `translateY(${-idx * 1.25}em)` }}
      >
        {['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <span key={d} className="h-[1.25em] leading-[1.25em]">
            {d}
          </span>
        ))}
      </span>
    </span>
  )
}

/** 数字值 → 滚筒组 + 单位后缀（统一 1.25em 行盒，数字与单位基线自然对齐） */
function OdometerNumber({ value }: { value: number }): React.JSX.Element {
  return (
    <span className="inline-flex overflow-hidden">
      {String(value)
        .split('')
        .map((d, i) => (
          <OdometerDigit key={i} digit={d} />
        ))}
      <span className="h-[1.25em] leading-[1.25em]">&nbsp;ms</span>
    </span>
  )
}

/** 对照 LatencyCellView：探测中省略号脉冲；数字走滚筒滚动（含档位颜色渐变）；off = 跳板主机不探测 */
export function LatencyCell({
  status,
  off = false
}: {
  status: LatencyStatus
  off?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const isLoading = status === 'idle' || status === 'probing'
  const color =
    typeof status === 'number'
      ? status < 80
        ? 'text-ok'
        : status < 200
          ? 'text-warn'
          : 'text-danger'
      : status === 'unreachable'
        ? 'text-danger'
        : 'text-muted'

  return (
    <div className="flex h-6 items-center font-mono text-minor font-medium">
      {off ? (
        <span className="text-muted/70">—</span>
      ) : isLoading ? (
        <span className="inline-block animate-[pulse-soft_0.65s_ease-in-out_infinite_alternate] text-muted">
          …
        </span>
      ) : typeof status === 'number' ? (
        <span className={cn(color, 'transition-colors duration-300')}>
          <OdometerNumber value={status} />
        </span>
      ) : (
        <span className={cn('animate-[latency-in_0.22s_ease-in-out]', color)}>
          {t('conn.latencyUnreachable')}
        </span>
      )}
    </div>
  )
}

/** 字节总量 → 紧凑人类可读（性能列用，如 800MB / 19.5GB） */
function fmtTotal(bytes: number): string {
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)}MB`
  const gb = bytes / 1024 ** 3
  const s = gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)
  return `${s}GB`
}

/** 占比 → 进度条颜色（≥90 危险、≥70 警示；健康档固定绿，不随主题色变化） */
function pctBarCls(pct: number): string {
  if (pct >= 90) return 'bg-danger'
  if (pct >= 70) return 'bg-warn'
  return 'bg-ok'
}

/** 占比 → 数值颜色（阈值 ≥90 红 / ≥70 黄；fixedOk = 健康档绿字，否则前景色） */
function pctTextCls(pct: number, fixedOk = false): string {
  if (pct >= 90) return 'text-danger'
  if (pct >= 70) return 'text-warn'
  return fixedOk ? 'text-ok' : 'text-fg/80'
}

/**
 * 性能区固定三行：CPU / 内存 / 磁盘各占一行指标条（网速仅会话性能面板展示）；
 * 核心数/内存总量/磁盘总量/swap 收敛到悬浮 tooltip。
 */
export function PerfCell({ sample }: { sample: PerfSample | null }): React.JSX.Element {
  const { t } = useTranslation()
  const detail =
    sample && (sample.osName !== '' || sample.swapPct !== null)
      ? [
          sample.osName,
          sample.cores > 0 ? `CPU ${sample.cores}C` : null,
          sample.swapPct !== null ? `swap ${sample.swapPct}%` : null,
          `MEM ${fmtTotal(sample.memTotal)}`,
          `DISK ${fmtTotal(sample.diskTotal)}`
        ]
          .filter((x): x is string => x !== null)
          .join(' · ')
      : sample
        ? `MEM ${fmtTotal(sample.memTotal)} · DISK ${fmtTotal(sample.diskTotal)}`
        : ''

  return (
    <div
      className="grid h-[51px] w-full min-w-0 max-w-[360px] grid-rows-3 gap-[3px]"
      title={detail || undefined}
    >
      {sample ? (
        <>
          <div className="flex h-[15px] min-w-0 items-center leading-none">
            <PerfMetric label={t('conn.perfCpu')} pct={sample.cpuPct} className="flex-1" />
          </div>
          <div className="flex h-[15px] min-w-0 items-center leading-none">
            <PerfMetric label={t('conn.perfMem')} pct={sample.memPct} className="flex-1" />
          </div>
          {/* 磁盘：健康档用固定绿；总量保留在 tooltip */}
          <div className="flex h-[15px] min-w-0 items-center leading-none">
            <PerfMetric
              label={t('conn.perfDisk')}
              pct={sample.diskPct}
              fixedOk
              className="flex-1"
            />
          </div>
        </>
      ) : (
        Array.from({ length: 3 }, (_, i) => <div key={i} className="h-[15px]" />)
      )}
    </div>
  )
}

/** 单指标：label + 细进度条 + 数值（进度条固定三档语义色，健康=固定绿；fixedOk = 数值健康档绿字） */
function PerfMetric({
  label,
  pct,
  className,
  fixedOk = false
}: {
  label: string
  pct: number | null
  className?: string
  fixedOk?: boolean
}): React.JSX.Element {
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <span className="w-8 shrink-0 truncate text-caption text-muted">{label}</span>
      <div className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-line">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500 ease-out',
            pct === null ? 'bg-muted/50' : pctBarCls(pct)
          )}
          style={{ width: `${pct === null ? 0 : Math.min(100, pct)}%` }}
        />
      </div>
      <span
        className={cn(
          'w-[30px] shrink-0 text-right font-mono text-caption tabular-nums',
          pct === null ? 'text-fg/80' : pctTextCls(pct, fixedOk)
        )}
      >
        {pct === null ? '—' : `${pct}%`}
      </span>
    </div>
  )
}
