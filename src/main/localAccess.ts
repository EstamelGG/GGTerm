import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { shell } from 'electron'
import type { ProtectedFolder } from '../shared/localAccess'
import { t } from './i18n'

const HOME = resolve(homedir())

const FOLDER_ROOT: Record<ProtectedFolder, string> = {
  downloads: resolve(HOME, 'Downloads'),
  documents: resolve(HOME, 'Documents'),
  desktop: resolve(HOME, 'Desktop')
}

const SETTINGS_URL: Record<ProtectedFolder, string> = {
  downloads: 'x-apple.systempreferences:com.apple.preference.security?Privacy_DownloadsFolder',
  documents: 'x-apple.systempreferences:com.apple.preference.security?Privacy_DocumentsFolder',
  desktop: 'x-apple.systempreferences:com.apple.preference.security?Privacy_DesktopFolder'
}

const FOLDER_LABEL_KEY: Record<ProtectedFolder, string> = {
  downloads: 'localAccess.folderDownloads',
  documents: 'localAccess.folderDocuments',
  desktop: 'localAccess.folderDesktop'
}

export type LocalAccessError = Error & { folder: ProtectedFolder; path: string }

function underRoot(filePath: string, root: string): boolean {
  const resolved = resolve(filePath)
  return resolved === root || resolved.startsWith(root + sep)
}

export function protectedFolderOf(filePath: string): ProtectedFolder | null {
  if (process.platform !== 'darwin') return null
  const resolved = resolve(filePath)
  for (const folder of Object.keys(FOLDER_ROOT) as ProtectedFolder[]) {
    if (underRoot(resolved, FOLDER_ROOT[folder])) return folder
  }
  return null
}

export function isLocalAccessErrno(err: unknown): boolean {
  const code =
    err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : ''
  return code === 'EPERM' || code === 'EACCES'
}

export function openFolderPrivacySettings(folder: ProtectedFolder): void {
  if (process.platform !== 'darwin') return
  void shell.openExternal(SETTINGS_URL[folder])
}

/** EPERM/EACCES 落在受保护目录时，返回本地化说明 + 系统原文（供传输镜像 / AI 工具卡） */
export function localAccessDeniedError(filePath: string, cause: unknown): LocalAccessError | null {
  if (!isLocalAccessErrno(cause)) return null
  const folder = protectedFolderOf(filePath)
  if (!folder) return null
  const system = cause instanceof Error ? cause.message : String(cause)
  const message = [
    t('localAccess.denied', { folder: t(FOLDER_LABEL_KEY[folder]) }),
    t('localAccess.systemError', { message: system }),
    filePath
  ].join('\n')
  return Object.assign(new Error(message), { folder, path: filePath })
}
