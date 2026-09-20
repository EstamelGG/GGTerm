import { beforeEach, expect, it, vi } from 'vitest'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createChatModel } from '../src/main/ai/provider'
import { getApiKey } from '../src/main/data/aiSecrets'
import type { AiConfig } from '../src/shared/types'

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => ({ chatModel: vi.fn(() => ({})) }))
}))
vi.mock('../src/main/data/aiSecrets', () => ({ getApiKey: vi.fn(() => 'stored-test-key') }))
beforeEach(() => vi.clearAllMocks())

it('免密供应商不读取或传递已存密钥，其他供应商继续使用自己的密钥', () => {
  const config: AiConfig = {
    providers: [
      { id: 'local', label: 'Local', baseURL: 'http://localhost:1234', noKey: true },
      { id: 'cloud', label: 'Cloud', baseURL: 'https://example.test' }
    ],
    scenarios: {
      chat: { providerId: 'local', model: 'm' },
      judge: { providerId: 'cloud', model: 'm' }
    },
    approvalLevel: 'default'
  }
  createChatModel(config)
  expect(getApiKey).not.toHaveBeenCalled()
  expect(createOpenAICompatible).toHaveBeenLastCalledWith(
    expect.objectContaining({ apiKey: undefined })
  )
  createChatModel(config, 'judge')
  expect(getApiKey).toHaveBeenCalledWith('cloud')
  expect(createOpenAICompatible).toHaveBeenLastCalledWith(
    expect.objectContaining({ apiKey: 'stored-test-key' })
  )
})
