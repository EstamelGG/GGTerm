import Store from 'electron-store'
import type { AiConfig, AppPreferencesData } from '../../shared/types'
import { AI_DEFAULTS } from '../../shared/ai'

/** 对照 Swift AppPreferences（UserDefaults：aterminal.confirmClose / aterminal.accentHex） */
const store = new Store<AppPreferencesData>({
  name: 'preferences',
  defaults: {
    confirmCloseSession: true,
    accentHex: '#37A563',
    locale: 'auto',
    perfMonitorDisabled: false,
    bgTransparency: 100,
    uiScale: 100,
    terminalFontSize: 12,
    ai: AI_DEFAULTS
  }
})

/**
 * AI 配置迁移（读时惰性执行，写回由后续任意 prefs.set 自然完成）：
 *   gen1 旧单模型平铺（provider/baseURL/model/subModel）→
 *   gen2 profiles 档案 →
 *   gen3 providers + scenarios（现行）：档案 → 供应商（id 不变，密钥无缝沿用），
 *   chat = 激活档案模型，judge = 其 subModel（空则缺省回退 chat）。
 */
function migrateAi(raw: unknown): AiConfig {
  const rawObj = (raw ?? {}) as Partial<AiConfig> & {
    profiles?: Array<{
      id: string
      label: string
      baseURL: string
      model: string
      subModel?: string
    }>
    activeProfileId?: string
    provider?: string
    baseURL?: string
    model?: string
    subModel?: string
  }
  // gen3：现行结构
  if (Array.isArray(rawObj.providers) && rawObj.providers.length > 0) {
    return { ...AI_DEFAULTS, ...rawObj, scenarios: rawObj.scenarios ?? {} }
  }
  // gen2：profiles → providers + scenarios
  if (Array.isArray(rawObj.profiles) && rawObj.profiles.length > 0) {
    const providers = rawObj.profiles.map((p) => ({ id: p.id, label: p.label, baseURL: p.baseURL }))
    const active =
      rawObj.profiles.find((p) => p.id === rawObj.activeProfileId) ?? rawObj.profiles[0]
    const scenarios: AiConfig['scenarios'] = {}
    if (active?.model) scenarios.chat = { providerId: active.id, model: active.model }
    if (active?.subModel) scenarios.judge = { providerId: active.id, model: active.subModel }
    return { ...AI_DEFAULTS, providers, scenarios }
  }
  // gen1：单模型平铺 → 合成 default 供应商
  const scenarios: AiConfig['scenarios'] = {}
  if (rawObj.model) scenarios.chat = { providerId: 'default', model: rawObj.model }
  if (rawObj.subModel) scenarios.judge = { providerId: 'default', model: rawObj.subModel }
  return {
    ...AI_DEFAULTS,
    providers: [
      {
        id: 'default',
        label: rawObj.provider ?? 'DeepSeek',
        baseURL: rawObj.baseURL ?? ''
      }
    ],
    scenarios
  }
}

export function getPreferences(): AppPreferencesData {
  return {
    confirmCloseSession: store.get('confirmCloseSession'),
    accentHex: store.get('accentHex'),
    locale: store.get('locale'),
    perfMonitorDisabled: store.get('perfMonitorDisabled'),
    bgTransparency: store.get('bgTransparency'),
    uiScale: store.get('uiScale'),
    terminalFontSize: store.get('terminalFontSize'),
    ai: migrateAi(store.get('ai'))
  }
}

/** 偏好变更通知（ipc 层注入广播；本模块保持不依赖 electron） */
let changeNotifier: ((prefs: AppPreferencesData) => void) | null = null

export function setPrefsNotifier(fn: ((prefs: AppPreferencesData) => void) | null): void {
  changeNotifier = fn
}

export function setPreferences(patch: Partial<AppPreferencesData>): AppPreferencesData {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) store.set(key as keyof AppPreferencesData, value)
  }
  const next = getPreferences()
  // main 侧任意写入（模型缓存等）统一广播：渲染层镜像据此同步
  changeNotifier?.(next)
  return next
}
