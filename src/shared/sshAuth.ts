import type { AuthType, ConnectionSecrets } from './types'

export function selectAuth(
  auth: AuthType,
  secrets: Partial<ConnectionSecrets>
): {
  password?: string
  privateKey?: string
  passphrase?: string
} {
  return auth === 'privateKey' || (auth === 'manual' && !!secrets.privateKey)
    ? { privateKey: secrets.privateKey || undefined, passphrase: secrets.passphrase || undefined }
    : { password: secrets.password ?? '' }
}
