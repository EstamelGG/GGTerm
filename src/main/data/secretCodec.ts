import { safeStorage } from 'electron'

/** 连接凭据与 AI 密钥共用的存储编码；保留既有 enc:/plain: 格式。 */
const encryptedPrefix = 'enc:'
const plainPrefix = 'plain:'

export function seal(plain: string): string {
  if (!plain) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return encryptedPrefix + safeStorage.encryptString(plain).toString('base64')
  }
  return plainPrefix + Buffer.from(plain, 'utf8').toString('base64')
}

export function open(sealed: string | undefined): string {
  if (!sealed) return ''
  if (sealed.startsWith(encryptedPrefix)) {
    try {
      return safeStorage.decryptString(Buffer.from(sealed.slice(encryptedPrefix.length), 'base64'))
    } catch {
      return ''
    }
  }
  if (sealed.startsWith(plainPrefix)) {
    return Buffer.from(sealed.slice(plainPrefix.length), 'base64').toString('utf8')
  }
  return ''
}
