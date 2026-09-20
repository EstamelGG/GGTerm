import type {
  AiConfig,
  AiContextSettings,
  AiModelBinding,
  AiProvider,
  AiProviderPreset
} from './types'

export const MIN_CONTEXT_WINDOW = 8192
export const MAX_CONTEXT_WINDOW = 1_048_576
export const DEFAULT_CONTEXT_SETTINGS: AiContextSettings = {
  contextWindow: 32_768,
  autoCompress: true
}
export const modelSettingsKey = (binding: AiModelBinding): string =>
  JSON.stringify([binding.providerId, binding.model])
export function contextSettingsFor(
  config: AiConfig,
  binding = config.scenarios.chat
): AiContextSettings {
  const value = binding ? config.modelSettings?.[modelSettingsKey(binding)] : undefined
  return {
    contextWindow:
      Number.isInteger(value?.contextWindow) &&
      value!.contextWindow >= MIN_CONTEXT_WINDOW &&
      value!.contextWindow <= MAX_CONTEXT_WINDOW
        ? value!.contextWindow
        : DEFAULT_CONTEXT_SETTINGS.contextWindow,
    autoCompress: value?.autoCompress !== false
  }
}

/** 预设：provider → 默认 baseURL（新建供应商时的快捷填充，本质均走 OpenAI-compatible） */
export const AI_PRESETS: Record<AiProviderPreset, { baseURL: string }> = {
  deepseek: { baseURL: 'https://api.deepseek.com' },
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  ollama: { baseURL: 'http://localhost:11434/v1' },
  custom: { baseURL: '' }
}

/** 默认供应商（DeepSeek；id 固定 'default'，旧档案迁移目标亦为它） */
export const DEFAULT_PROVIDER_ID = 'default'

export const DEFAULT_PROVIDER: AiProvider = {
  id: DEFAULT_PROVIDER_ID,
  label: 'DeepSeek',
  baseURL: AI_PRESETS.deepseek.baseURL
}

export const AI_DEFAULTS: AiConfig = {
  providers: [DEFAULT_PROVIDER],
  scenarios: { chat: { providerId: DEFAULT_PROVIDER_ID, model: 'deepseek-chat' } },
  approvalLevel: 'default'
}
