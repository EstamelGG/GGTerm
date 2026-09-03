import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  Info,
  Monitor,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal
} from 'lucide-react'
import appIcon from '../../../../build/icon.png'
import type { LucideIcon } from 'lucide-react'
import type { AiApprovalLevel, AppPreferencesData } from '@shared/types'
import { AI_DEFAULTS } from '@shared/ai'
import { UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from '@shared/prefs'
import { cn } from '@/lib/utils'
import { Button } from '@/components/form/Buttons'
import { Switch } from '@/components/form/Switch'
import { Slider } from '@/components/form/Slider'
import { HexColorPicker } from '@/components/form/HexColorPicker'
import { SegmentedControl } from '@/components/ui/ChoiceChip'
import { ModelManagerPanel } from '@/components/ai/ModelManagerPanel'
import { usePrefsStore } from '@/stores/prefs'
import { useSessionStore } from '@/stores/session'
import { applyBgTransparency } from '@/lib/accent'

/**
 * 设置标签页（对照 VS Code Settings Editor：左侧分区导航 + 右侧内容面板）。
 * 内容三节：通用（主题色/语言）、主机（关闭确认/性能监控）、AI（模型摘要+审批级别+模型管理）。
 * 常驻挂载 + CSS 显隐（App 主区域），表单状态不因切 tab 丢失；变更即时持久化。
 */

const LOCALE_OPTIONS = [
  { value: 'auto', key: 'settings.langAuto' },
  { value: 'zh-CN', key: 'settings.langZh' },
  { value: 'en', key: 'settings.langEn' }
] as const

const APPROVAL_OPTIONS = [
  {
    value: 'strict',
    key: 'settings.aiApprovalStrict',
    descKey: 'settings.aiApprovalStrictDesc'
  },
  {
    value: 'default',
    key: 'settings.aiApprovalDefault',
    descKey: 'settings.aiApprovalDefaultDesc'
  },
  {
    value: 'relaxed',
    key: 'settings.aiApprovalRelaxed',
    descKey: 'settings.aiApprovalRelaxedDesc'
  }
] as const

/** 审批强度图标（盾牌系）：严格=盾+勾（安全受控）/ 默认=盾 / 宽松=盾+叹号（需警惕）；
 *  颜色语义沿用 严格=蓝 / 默认=绿 / 宽松=红（设置 chips 与对话切换器共用） */
const APPROVAL_ICONS: Record<AiApprovalLevel, LucideIcon> = {
  strict: ShieldCheck,
  default: Shield,
  relaxed: ShieldAlert
}
const APPROVAL_ICON_CLS: Record<AiApprovalLevel, string> = {
  strict: 'text-info',
  default: 'text-ok',
  relaxed: 'text-danger'
}

/** 左侧分区导航项 */
const SECTIONS = [
  { id: 'general', icon: SlidersHorizontal, key: 'settings.sectionGeneral' },
  { id: 'host', icon: Monitor, key: 'settings.sectionHost' },
  { id: 'ai', icon: Bot, key: 'settings.sectionAi' }
] as const

/** about 独立于 SECTIONS（导航里以分割线隔开），并入 SectionId 供深链与面板切换 */
type SectionId = (typeof SECTIONS)[number]['id'] | 'about'

/** 分节卡片（内容面板统一骨架：标题 + 描述 + 内容） */
function Section({
  id,
  title,
  desc,
  active,
  children
}: {
  id: SectionId
  title: string
  desc?: string
  active: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section id={`settings-${id}`} className={cn('scroll-mt-4', !active && 'hidden')}>
      <h2 className="text-title font-semibold text-fg">{title}</h2>
      {desc && <p className="mt-0.5 text-caption leading-relaxed text-muted">{desc}</p>}
      <div className="mt-3 flex flex-col gap-3.5">{children}</div>
    </section>
  )
}

/** 一行设置项（label 左 / 控件右；对照 macOS System Settings row） */
function Row({
  title,
  desc,
  children
}: {
  title: string
  desc?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 rounded-lg border border-line px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-body text-fg">{title}</div>
        {desc && <div className="mt-0.5 text-caption leading-relaxed text-muted">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/**
 * 背景透明度行：拖动中只走本地预览（rAF 合并 → 直接改 CSS 变量 + 本地读数），松手才落库。
 * 预览态必须关在这一行内 —— 若每一步都写 prefs store，会触发全应用重渲染
 * 与偏好落盘（electron-store 同步写盘），滑块会明显滞涩。
 */
function BgTransparencyRow({
  value,
  onCommit
}: {
  value: number
  onCommit: (v: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  /** 拖动中的预览值；null = 未拖动，显示持久化值 */
  const [preview, setPreview] = useState<number | null>(null)
  const raf = useRef<number | null>(null)
  const latest = useRef(0)

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current)
    },
    []
  )

  /** 预览：一帧内多次 input 只应用一次（改 CSS 变量会触发整窗重绘，合并后更稳） */
  const previewTo = (v: number): void => {
    latest.current = v
    if (raf.current !== null) return
    raf.current = requestAnimationFrame(() => {
      raf.current = null
      applyBgTransparency(latest.current)
      setPreview(latest.current)
    })
  }

  const shown = preview ?? value
  return (
    <Row title={t('settings.bgTransparency')} desc={t('settings.bgTransparencyHint')}>
      <div className="flex w-48 items-center gap-2.5">
        <Slider
          label={t('settings.bgTransparency')}
          value={shown}
          onInput={previewTo}
          onCommit={(v) => {
            setPreview(null)
            onCommit(v)
          }}
        />
        <span className="w-9 shrink-0 text-right text-minor tabular-nums text-muted">{shown}%</span>
      </div>
    </Row>
  )
}

/**
 * 界面缩放行：拖动只更新读数，**不实时缩放** —— 一边拖一边整窗重排（终端还得重测字形 +
 * 重排 PTY）会明显跳跃，实际缩放与终端字号反算统一在松手落库那一次（applyUiScale）。
 */
function UiScaleRow({
  value,
  onCommit
}: {
  value: number
  onCommit: (v: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<number | null>(null)
  const shown = preview ?? value
  return (
    <Row title={t('settings.uiScale')} desc={t('settings.uiScaleHint')}>
      <div className="flex w-48 items-center gap-2.5">
        <Slider
          label={t('settings.uiScale')}
          value={shown}
          min={UI_SCALE_MIN}
          max={UI_SCALE_MAX}
          step={UI_SCALE_STEP}
          onInput={setPreview}
          onCommit={(v) => {
            setPreview(null)
            onCommit(v)
          }}
        />
        <span className="w-9 shrink-0 text-right text-minor tabular-nums text-muted">{shown}%</span>
      </div>
    </Row>
  )
}

export function SettingsPage({
  onToast
}: {
  /** 全局 toast（App flash 直通）：AI 密钥校验失败提示用 */
  onToast?: (text: string, danger?: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const prefs = usePrefsStore((s) => s.data)
  const onChange = usePrefsStore((s) => s.update)
  const tab = useSessionStore((s) => s.tab)
  const [section, setSection] = useState<SectionId>('general')
  const [relaxedConfirm, setRelaxedConfirm] = useState(false)

  // 深链定位：settings tab 携带 section 时切换分区（渲染期调整；切走 tab 时经 null 重置，可重复触发）
  const jumpSection = tab.kind === 'settings' ? (tab.section ?? null) : null
  const [prevJump, setPrevJump] = useState<string | null>(jumpSection)
  if (jumpSection !== prevJump) {
    setPrevJump(jumpSection)
    if (jumpSection) setSection(jumpSection)
  }

  const ai = prefs?.ai ?? AI_DEFAULTS
  // 对话场景当前绑定（供应商 · 模型）摘要展示
  const chatBinding = ai.scenarios.chat ?? null
  const chatProvider = chatBinding
    ? (ai.providers.find((p) => p.id === chatBinding.providerId) ?? null)
    : null
  const onChangeAi = (patch: Partial<AppPreferencesData['ai']>): void =>
    onChange({ ai: { ...ai, ...patch } })

  const pickApproval = (level: AiApprovalLevel): void => {
    if (level === 'relaxed' && ai.approvalLevel !== 'relaxed') {
      setRelaxedConfirm(true)
      return
    }
    onChangeAi({ approvalLevel: level })
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl gap-8 px-8 py-6">
        {/* 左侧分区导航（粘性） */}
        <nav className="sticky top-6 flex w-36 shrink-0 flex-col gap-0.5 self-start">
          <span className="mb-2 px-2 text-caption font-medium uppercase tracking-wide text-muted">
            {t('settings.title')}
          </span>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-body transition-colors',
                s.id === section ? 'bg-hover text-fg' : 'text-muted hover:bg-hover/60 hover:text-fg'
              )}
            >
              <s.icon size={14} strokeWidth={2} />
              {t(s.key)}
            </button>
          ))}
          {/* 关于：分割线与功能分区隔开 */}
          <div className="mx-2 my-1.5 h-px bg-line" />
          <button
            type="button"
            onClick={() => setSection('about')}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-body transition-colors',
              section === 'about'
                ? 'bg-hover text-fg'
                : 'text-muted hover:bg-hover/60 hover:text-fg'
            )}
          >
            <Info size={14} strokeWidth={2} />
            {t('settings.sectionAbout')}
          </button>
        </nav>

        {/* 右侧内容面板（单节显示） */}
        <div className="min-w-0 flex-1">
          <Section
            id="general"
            active={section === 'general'}
            title={t('settings.sectionGeneral')}
            desc={t('settings.sectionGeneralDesc')}
          >
            <div className="flex flex-col gap-2.5">
              <span className="text-body text-fg">{t('settings.theme')}</span>
              <HexColorPicker
                hex={prefs?.accentHex ?? '#37A563'}
                presetLabel={t('settings.presets')}
                onChange={(hex) => onChange({ accentHex: hex })}
              />
            </div>
            {/* 背景透明度：0% = 完全实色，100% = 设计默认层次 */}
            <BgTransparencyRow
              value={prefs?.bgTransparency ?? 100}
              onCommit={(v) => onChange({ bgTransparency: v })}
            />
            {/* 界面缩放：整体缩放 UI（5% 步进）；终端字号在渲染层反算抵消 */}
            <UiScaleRow value={prefs?.uiScale ?? 100} onCommit={(v) => onChange({ uiScale: v })} />
            <Row title={t('settings.language')}>
              <SegmentedControl
                value={prefs?.locale ?? 'auto'}
                onChange={(locale) => onChange({ locale })}
                options={LOCALE_OPTIONS.map((opt) => ({
                  value: opt.value,
                  label: t(opt.key)
                }))}
              />
            </Row>
          </Section>

          <Section
            id="host"
            active={section === 'host'}
            title={t('settings.sectionHost')}
            desc={t('settings.sectionHostDesc')}
          >
            <Row title={t('settings.confirmClose')} desc={t('settings.confirmCloseDesc')}>
              <Switch
                label={t('settings.confirmClose')}
                on={prefs?.confirmCloseSession ?? true}
                onChange={(v) => onChange({ confirmCloseSession: v })}
              />
            </Row>
            <Row title={t('settings.perfMonitor')} desc={t('settings.perfMonitorHint')}>
              <Switch
                label={t('settings.perfMonitor')}
                on={!(prefs?.perfMonitorDisabled ?? false)}
                onChange={(v) => onChange({ perfMonitorDisabled: !v })}
              />
            </Row>
          </Section>

          <Section
            id="ai"
            active={section === 'ai'}
            title={t('settings.sectionAi')}
            desc={t('settings.sectionAiDesc')}
          >
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-body text-fg">{t('settings.aiModels')}</span>
                <span className="truncate text-caption text-muted">
                  {chatBinding?.model
                    ? `${chatProvider?.label ?? ''} · ${chatBinding.model}`
                    : t('ai.modelNone')}
                </span>
              </div>
              <ModelManagerPanel onToast={onToast} />
            </div>
            {/* 审批偏好：标题+选择器一行，分割线下逐档说明 */}
            <div className="rounded-lg border border-line px-3 py-2.5">
              <div className="flex items-center justify-between gap-6">
                <div className="text-body text-fg">{t('settings.aiApprovalLevel')}</div>
                <SegmentedControl
                  value={ai.approvalLevel}
                  onChange={pickApproval}
                  options={APPROVAL_OPTIONS.map((opt) => ({
                    value: opt.value,
                    label: t(opt.key)
                  }))}
                />
              </div>
              <div className="my-2.5 h-px bg-line" />
              <div className="flex flex-col gap-2">
                {APPROVAL_OPTIONS.map((opt) => {
                  const Icon = APPROVAL_ICONS[opt.value]
                  return (
                    <div key={opt.value} className="flex items-center gap-2.5">
                      <Icon
                        size={13}
                        strokeWidth={2.2}
                        className={cn('shrink-0', APPROVAL_ICON_CLS[opt.value])}
                      />
                      <span className="w-10 shrink-0 text-minor font-medium text-fg">
                        {t(opt.key)}
                      </span>
                      <span className="min-w-0 flex-1 text-caption leading-relaxed text-muted">
                        {t(opt.descKey)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
            {/* 宽松模式确认：独立警示条占满整行宽度，文案可换行，不与选择器挤压 */}
            {relaxedConfirm && (
              <div className="flex items-center gap-2.5 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5">
                <ShieldAlert size={14} strokeWidth={2.2} className="shrink-0 text-danger" />
                <span className="min-w-0 flex-1 text-caption leading-relaxed text-danger">
                  {t('settings.aiRelaxedMessage')}
                </span>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    title={t('common.ok')}
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setRelaxedConfirm(false)
                      onChangeAi({ approvalLevel: 'relaxed' })
                    }}
                  />
                  <Button
                    title={t('common.cancel')}
                    variant="ghost"
                    size="sm"
                    onClick={() => setRelaxedConfirm(false)}
                  />
                </div>
              </div>
            )}
          </Section>

          {/* 关于：图标 + 名称 + 版本号 + 编译时间（构建期注入，见 electron.vite.config.ts renderer.define） */}
          <section
            id="settings-about"
            className={cn('scroll-mt-4', section !== 'about' && 'hidden')}
          >
            <div className="flex flex-col items-center gap-1.5 pt-10 text-center">
              <img src={appIcon} alt="GGTerm" className="size-16 rounded-xl" draggable={false} />
              <span className="mt-2 text-title font-semibold text-fg">GGTerm</span>
              <span className="text-caption text-muted">v{__APP_VERSION__}</span>
              <span className="mt-4 text-caption text-muted">
                {t('settings.aboutBuildTime')} · {new Date(__BUILD_TIME__).toLocaleString()}
              </span>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
