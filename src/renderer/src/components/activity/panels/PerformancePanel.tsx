import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { CopyIconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/utils'
import { usePerfStore } from '@/stores/perf'
import { useConnectionsStore } from '@/stores/connections'
import { fmtBytes, fmtSpeed } from '../format'

/**
 * 性能面板（活动栏，仅 SSH 会话页）：perf.watch 当前主机
 * （有活跃会话时借用共享连接，零额外连接），3s 样本。
 * 五个 section：系统信息 / CPU（总使用率折线 + 每核）/ 内存（饼图）/ 网络（上下行折线）/ 磁盘（盘汇总 + 挂载点）。
 * 折线图用 recharts；每核与磁盘容量为简单进度条（非图表）。
 */

const WINDOW_MS = 5 * 60 * 1000 // 图表固定展示 5 分钟时间窗

/** 语义色（非用户可配置）：绿=下行/空闲、红=上行/已用、黄=缓存 */
const C_OK = '#37a563'
const C_INFO = '#4a9eff'
const C_DANGER = '#e85858'
const C_WARN = '#eab308'

const TOOLTIP_STYLE = {
  backgroundColor: 'rgba(20,23,26,0.95)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 6,
  fontSize: 11,
  color: '#e8eaed'
}

/** 开机时长紧凑格式：3d 5h / 5h 12m / 12m */
function fmtUptime(sec: number): string {
  const m = Math.floor(sec / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h`
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m`
}

function fmtClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Y 轴刻度紧凑数值：0 / 512K / 3.4M / 1.2G */
function fmtTick(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)}G`
  if (abs >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)}M`
  if (abs >= 1024) return `${Math.round(v / 1024)}K`
  return `${v}`
}

/** section 容器：标题 + 内容 */
function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-caption font-semibold text-fg">{title}</div>
      {children}
    </div>
  )
}

/** 单行截断文本：仅在溢出被省略时，悬停显示完整内容 */
function TruncatedText({
  text,
  className
}: {
  text: string
  className?: string
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  return (
    <span
      ref={ref}
      className={cn('min-w-0 truncate', className)}
      onMouseEnter={() => {
        const el = ref.current
        if (el) el.title = el.scrollWidth > el.clientWidth ? text : ''
      }}
    >
      {text}
    </span>
  )
}

/** 详情行：label 左、value 右（mono，超长悬停看全文）；copyValue 有值时复制钮紧贴数值左侧 */
function InfoRow({
  label,
  value,
  copyValue
}: {
  label: string
  value: string
  copyValue?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-caption text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
        {copyValue && <CopyIconButton value={copyValue} label={t('common.copy')} />}
        <TruncatedText text={value} className="text-right font-mono text-caption text-fg" />
      </div>
    </div>
  )
}

/** 横向容量条（每核 / 磁盘占用共用；与列表性能列同三档语义色，健康=固定绿） */
function Meter({ pct }: { pct: number }): React.JSX.Element {
  const v = Math.min(100, Math.max(0, pct))
  return (
    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-hover">
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-300 ease-out',
          v >= 90 ? 'bg-danger' : v >= 70 ? 'bg-warn' : 'bg-ok'
        )}
        style={{ width: `${v}%` }}
      />
    </div>
  )
}

/** 百分比数字阈值语义色：≥90% 危险 / ≥70% 警告 / 其余默认前景 */
function pctTone(pct: number): string {
  if (pct >= 90) return 'text-danger'
  if (pct >= 70) return 'text-warn'
  return 'text-fg'
}

export function PerformancePanel({ hostId }: { hostId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const sample = usePerfStore((s) => s.samples[hostId] ?? null)
  const history = usePerfStore((s) => s.histories[hostId])
  /** GPU 走独立低频流（gpuSamples）：面板的 3s 全量采样不再带 GPU */
  const gpuSample = usePerfStore((s) => s.gpuSamples[hostId] ?? null)
  const host = useConnectionsStore((s) => s.connections.find((c) => c.id === hostId)?.host)

  if (!sample) {
    return <p className="py-8 text-center text-minor text-muted/60">{t('activity.perfWaiting')}</p>
  }

  // 内存三栏：空闲 / 缓存 / 已用
  const memFree = sample.memFree ?? 0
  const memCache = sample.memCache ?? 0
  const memUsed = Math.max(0, sample.memTotal - memFree - memCache)
  const memPie = [
    { name: t('activity.perfMemUsed'), value: memUsed, color: C_DANGER },
    { name: t('activity.perfMemCache'), value: memCache, color: C_WARN },
    { name: t('activity.perfMemFree'), value: memFree, color: C_OK }
  ].filter((d) => d.value > 0)

  const gpus = gpuSample?.gpus ?? []
  const cpuData = (history?.cpu ?? []).map((p) => ({ t: p.t, v: p.v }))
  const netData = (history?.net ?? []).map((p) => ({ t: p.t, rx: p.rx, tx: p.tx }))

  // 固定 5 分钟滑动窗口（右对齐最新样本）：数据从右进入、向左滑出，缺失部分留空
  const xDomain: [number, number] = [sample.t - WINDOW_MS, sample.t]

  return (
    <div className="flex flex-col gap-3">
      {/* ① 系统信息 */}
      <Section title={t('activity.perfSystem')}>
        <div className="flex flex-col gap-1.5">
          <InfoRow label={t('activity.perfIp')} value={host ?? '—'} copyValue={host || undefined} />
          <InfoRow
            label={t('activity.perfOs')}
            value={sample.osName || '—'}
            copyValue={sample.osName || undefined}
          />
          <InfoRow label={t('activity.perfTimezone')} value={sample.timezone || '—'} />
          <InfoRow
            label={t('activity.perfUptime')}
            value={sample.uptimeSec != null ? fmtUptime(sample.uptimeSec) : '—'}
          />
        </div>
      </Section>

      {/* ② CPU */}
      <Section title={t('activity.perfCpu')}>
        <div className="flex items-baseline justify-between">
          <span className="text-caption text-muted">{t('activity.perfCpuTotal')}</span>
          <span
            className={cn(
              'font-mono text-body',
              sample.cpuPct === null ? 'text-fg' : pctTone(sample.cpuPct)
            )}
          >
            {sample.cpuPct === null ? '—' : `${sample.cpuPct}%`}
          </span>
        </div>
        <div className="h-16">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={cpuData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <CartesianGrid horizontal vertical={false} stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="t" type="number" domain={xDomain} hide />
              <YAxis
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                width={28}
                tick={{ fontSize: 11, fill: '#949ba3' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                labelFormatter={(t) => fmtClock(t as number)}
                formatter={(v) => [`${v}%`, t('activity.perfCpuTotal')]}
                contentStyle={TOOLTIP_STYLE}
                labelStyle={{ color: '#949ba3' }}
              />
              <Line
                type="monotone"
                dataKey="v"
                stroke={C_INFO}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-caption text-muted">{t('activity.perfCpuCores')}</div>
          {sample.perCore.length === 0 ? (
            <div className="py-2 text-center text-caption text-muted/50">···</div>
          ) : (
            sample.perCore.map((v, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-right font-mono text-caption text-muted">
                  {i}
                </span>
                <Meter pct={v} />
                <span className={cn('w-11 shrink-0 text-right font-mono text-caption', pctTone(v))}>
                  {v}%
                </span>
              </div>
            ))
          )}
        </div>
      </Section>

      {/* ③ 内存 */}
      <Section title={t('activity.perfMem')}>
        <div className="flex items-baseline justify-between">
          <span className="text-caption text-muted">{t('activity.perfMemTotal')}</span>
          <span className="font-mono text-body text-fg">{fmtBytes(sample.memTotal)}</span>
        </div>
        <div className="h-24">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={memPie}
                dataKey="value"
                nameKey="name"
                innerRadius={26}
                outerRadius={40}
                paddingAngle={2}
                strokeWidth={0}
                isAnimationActive={false}
              >
                {memPie.map((d) => (
                  <Cell key={d.name} fill={d.color} />
                ))}
              </Pie>
              <Tooltip
                formatter={(v) => fmtBytes(Number(v))}
                contentStyle={TOOLTIP_STYLE}
                labelStyle={{ color: '#949ba3' }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-col gap-1">
          {memPie.map((d) => (
            <div key={d.name} className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.color }} />
              <span className="text-caption text-muted">{d.name}</span>
              <span className="ml-auto font-mono text-caption text-fg">{fmtBytes(d.value)}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* ④ GPU（独立低频流：远端无 nvidia-smi / 无卡 → 空数组，整段不渲染） */}
      {gpus.length > 0 && (
        <Section title={t('activity.perfGpu')}>
          {gpus.map((g) => {
            const gpuMemPct = g.memTotal > 0 ? (g.memUsed / g.memTotal) * 100 : 0
            const meta = [
              g.tempC !== null ? `${g.tempC}°C` : '',
              g.powerW !== null
                ? `${Math.round(g.powerW)}W${g.powerCapW !== null ? ` / ${Math.round(g.powerCapW)}W` : ''}`
                : '',
              g.fanPct !== null ? `${t('activity.perfGpuFan')} ${g.fanPct}%` : ''
            ].filter((v) => v !== '')
            return (
              <div
                key={g.index}
                className="flex flex-col gap-1 rounded-lg border border-line bg-raised/40 p-2"
              >
                {/* 名称完整显示、允许换行（型号可能很长，不做省略号截断） */}
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 flex-1 break-words text-body text-fg">
                    {t('activity.perfGpuIndex', { index: g.index })} · {g.name || '—'}
                  </span>
                  {g.driver !== '' && (
                    <span className="shrink-0 font-mono text-caption text-muted">{g.driver}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-12 shrink-0 text-caption text-muted">
                    {t('activity.perfGpuUtil')}
                  </span>
                  <Meter pct={g.utilPct ?? 0} />
                  <span
                    className={cn(
                      'w-11 shrink-0 text-right font-mono text-caption',
                      g.utilPct === null ? 'text-muted' : pctTone(g.utilPct)
                    )}
                  >
                    {g.utilPct === null ? '—' : `${g.utilPct}%`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-12 shrink-0 text-caption text-muted">
                    {t('activity.perfGpuMem')}
                  </span>
                  <Meter pct={gpuMemPct} />
                  <span className="shrink-0 text-right font-mono text-caption text-fg">
                    {fmtBytes(g.memUsed)} / {fmtBytes(g.memTotal)}
                  </span>
                </div>
                {meta.length > 0 && (
                  <div className="font-mono text-caption text-muted">{meta.join(' · ')}</div>
                )}
                {/* 占用显存最多的计算进程（top5）：路径完整显示、允许换行 */}
                {g.procs.length > 0 && (
                  <div className="mt-1 flex flex-col gap-1 border-t border-line pt-1.5">
                    <div className="text-caption text-muted">{t('activity.perfGpuProcs')}</div>
                    {g.procs.map((p) => (
                      <div key={p.pid} className="flex items-start gap-2">
                        <span className="min-w-0 flex-1 break-words font-mono text-caption text-fg">
                          {p.name}
                          <span className="text-muted/60"> {p.pid}</span>
                        </span>
                        <span className="shrink-0 font-mono text-caption text-muted">
                          {fmtBytes(p.mem)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </Section>
      )}

      {/* ⑤ 网络 */}
      <Section title={t('activity.perfNet')}>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-caption text-muted">
            <span className="h-2 w-2 rounded-full" style={{ background: C_OK }} />
            {t('activity.perfNetDown')}
            <span className="font-mono text-fg">{fmtSpeed(sample.netRx ?? 0)}</span>
          </span>
          <span className="flex items-center gap-1.5 text-caption text-muted">
            <span className="h-2 w-2 rounded-full" style={{ background: C_DANGER }} />
            {t('activity.perfNetUp')}
            <span className="font-mono text-fg">{fmtSpeed(sample.netTx ?? 0)}</span>
          </span>
        </div>
        <div className="h-16">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={netData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <CartesianGrid horizontal vertical={false} stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="t" type="number" domain={xDomain} hide />
              <YAxis
                domain={[0, 'auto']}
                tickCount={5}
                width={36}
                tick={{ fontSize: 11, fill: '#949ba3' }}
                tickFormatter={fmtTick}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                labelFormatter={(t) => fmtClock(t as number)}
                formatter={(v, name) => [
                  fmtSpeed(Number(v)),
                  name === 'rx' ? t('activity.perfNetDown') : t('activity.perfNetUp')
                ]}
                contentStyle={TOOLTIP_STYLE}
                labelStyle={{ color: '#949ba3' }}
              />
              <Line
                type="monotone"
                dataKey="rx"
                stroke={C_OK}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="tx"
                stroke={C_DANGER}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Section>

      {/* ⑥ 磁盘 */}
      <Section title={t('activity.perfDisk')}>
        {sample.disks.length === 0 ? (
          <div className="py-2 text-center text-caption text-muted/50">—</div>
        ) : (
          sample.disks.map((d) => {
            const used = d.mounts.reduce((sum, m) => sum + m.used, 0)
            const usePct = d.total > 0 ? (used / d.total) * 100 : 0
            return (
              <div
                key={d.name}
                className="flex flex-col gap-1 rounded-lg border border-line bg-raised/40 p-2"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-mono text-body text-fg">{d.name}</span>
                  <span className="shrink-0 font-mono text-caption text-muted">
                    {fmtBytes(used)} / {fmtBytes(d.total)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Meter pct={usePct} />
                  <span
                    className={cn(
                      'w-11 shrink-0 text-right font-mono text-caption',
                      pctTone(usePct)
                    )}
                  >
                    {usePct.toFixed(1)}%
                  </span>
                </div>
                <div className="flex items-center gap-3 font-mono text-caption text-muted">
                  <span>
                    {t('activity.perfDiskRead')} {fmtSpeed(d.readBps ?? 0)}
                  </span>
                  <span>
                    {t('activity.perfDiskWrite')} {fmtSpeed(d.writeBps ?? 0)}
                  </span>
                </div>
                {d.mounts.length > 0 && (
                  <div className="mt-1 flex flex-col gap-1 border-t border-line pt-1.5">
                    {d.mounts.map((m) => (
                      <div key={m.mount} className="flex flex-col gap-0.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg">
                            {m.mount}
                            <span className="text-muted/60"> ({m.fstype})</span>
                          </span>
                          <span
                            className={cn('shrink-0 font-mono text-caption', pctTone(m.usePct))}
                          >
                            {m.usePct}%
                          </span>
                        </div>
                        <div className="font-mono text-caption text-muted">
                          {fmtBytes(m.used)} / {fmtBytes(m.size)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
      </Section>
    </div>
  )
}
