import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { AiConfig, AiModelBinding, AiScenario } from '../../shared/types'
import { getApiKey } from '../data/aiSecrets'
import { modelFetch } from './modelFetch'

/** 场景回退链：title 未配置 → judge；judge 未配置 → chat */
const SCENARIO_FALLBACK: Partial<Record<AiScenario, AiScenario>> = { title: 'judge', judge: 'chat' }

/** 解析场景最终绑定（沿回退链收敛到 chat；全空 = 未配置） */
export function resolveBinding(config: AiConfig, scenario: AiScenario): AiModelBinding | null {
  let s = scenario
  let binding = config.scenarios[s] ?? null
  while (!binding && SCENARIO_FALLBACK[s]) {
    s = SCENARIO_FALLBACK[s] as AiScenario
    binding = config.scenarios[s] ?? null
  }
  return binding
}

/**
 * 从 AI 配置构建模型（OpenAI-compatible 一套覆盖 DeepSeek/Qwen/Ollama/自建网关）。
 * 按 scenario 取场景绑定（未配置沿 title→judge→chat 回退），密钥按供应商 id 取。
 * 思维链回传：DeepSeek 带 tools 的请求要求回传 reasoning_content，SDK 多步循环内默认即回传，不做剥离。
 */
export function createChatModel(config: AiConfig, scenario: AiScenario = 'chat'): LanguageModel {
  const binding = resolveBinding(config, scenario)
  if (!binding?.model) throw new Error('Chat model not configured: Settings → AI → Scene config')
  const provider = config.providers.find((p) => p.id === binding.providerId)
  if (!provider?.baseURL)
    throw new Error('Model provider missing BaseURL: Settings → AI → Providers')
  return createOpenAICompatible({
    name: provider.label,
    baseURL: provider.baseURL,
    apiKey: provider.noKey ? undefined : getApiKey(provider.id),
    fetch: modelFetch
  }).chatModel(binding.model)
}
