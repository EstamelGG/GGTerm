import Store from 'electron-store'
import { seal, open } from './secretCodec'
import type { ConnectionSecrets } from '../../shared/types'

/**
 * 凭据存储：对照 Swift KeychainSecrets（macOS Keychain，service com.estamelgg.ATerminal-Swift）
 * Electron 侧用 safeStorage 加密（macOS 底层同为 Keychain），密文 base64 落 userData/secrets.json
 */
const store = new Store<{ secrets: Record<string, string[]> }>({
  name: 'secrets',
  defaults: { secrets: {} }
})

/** 保存（空值字段即清除，对照 Swift 先删后加语义） */
export function saveSecrets(id: string, secrets: Partial<ConnectionSecrets>): void {
  const all = store.get('secrets')
  const old = all[id] ?? ['', '', '']
  const next = [
    secrets.password !== undefined ? seal(secrets.password) : old[0],
    secrets.privateKey !== undefined ? seal(secrets.privateKey) : old[1],
    secrets.passphrase !== undefined ? seal(secrets.passphrase) : old[2]
  ]
  if (next.every((v) => !v)) delete all[id]
  else all[id] = next
  store.set('secrets', all)
}

export function loadSecrets(id: string): ConnectionSecrets {
  const entry = store.get('secrets')[id] ?? ['', '', '']
  return {
    password: open(entry[0]),
    privateKey: open(entry[1]),
    passphrase: open(entry[2])
  }
}

export function deleteSecrets(id: string): void {
  const all = store.get('secrets')
  delete all[id]
  store.set('secrets', all)
}
