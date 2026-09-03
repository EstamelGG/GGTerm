import type { AiConfig, AiProvider, AiProviderPreset } from './types'

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
