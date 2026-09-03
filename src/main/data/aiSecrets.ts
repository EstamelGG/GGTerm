import Store from 'electron-store'
import { seal, open } from './secretCodec'

/**
 * AI 密钥存储（按模型档案 id 分键）：复用 secrets.ts 的 safeStorage 封装
 * （macOS 底层同为 Keychain）。与连接凭据分库，避免连接导出/删除逻辑误触 AI Key。
 * 旧版单 key（apiKey 字段）惰性迁移到 keys['default']。
 */
const store = new Store<{ apiKey: string; keys: Record<string, string> }>({
  name: 'ai-secrets',
  defaults: { apiKey: '', keys: {} }
})

/** 旧单 key 首次访问时搬进 keys['default'] */
function legacyToDefault(): void {
  const legacy = store.get('apiKey')
  if (!legacy) return
  const keys = store.get('keys')
  if (keys['default'] === undefined) {
    store.set('keys', { ...keys, default: legacy })
  }
  store.set('apiKey', '')
}

export function getApiKey(profileId: string): string {
  legacyToDefault()
  return open(store.get('keys')[profileId])
}

export function setApiKey(profileId: string, apiKey: string): void {
  legacyToDefault()
  store.set('keys', { ...store.get('keys'), [profileId]: seal(apiKey) })
}
