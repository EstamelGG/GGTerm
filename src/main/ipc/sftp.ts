import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { sep as pathSep, resolve as resolvePath } from 'node:path'
import type { EncodingMode, FileEncoding } from '../../shared/encoding'
import { errorMessage } from '../../shared/error'
import type { ProtectedFolder } from '../../shared/localAccess'
import type { SftpEntry } from '../../shared/types'
import { findTransferSession } from '../ai/agentLinks'
import { openFolderPrivacySettings } from '../localAccess'
import { appLog } from '../log'
import type { HostLinkEvents } from '../ssh/link'
import { resourceSftp, stopResourceSftp } from '../ssh/resourceLink'
import type { SftpSession } from '../ssh/sftp'
import { pickLocalPaths } from '../ssh/sftp'

import { channels } from './channels'

export function registerSftpIpc(
  linkEvents: (sender: Electron.WebContents) => HostLinkEvents
): void {
  /* ---------------- SFTP（阶段④，对照 SftpController 的 IPC 化） ---------------- */

  const sftpOf = (hostId: string): SftpSession => {
    const sender = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed()
    )?.webContents
    if (!sender) throw new Error('Application window is unavailable')
    return resourceSftp(hostId, linkEvents(sender))
  }

  ipcMain.handle(channels.sftpStart, (_e, hostId: string) => sftpOf(hostId).start())

  ipcMain.on(channels.sftpStop, (_e, hostId: string) => {
    stopResourceSftp(hostId)
  })

  // 列目录失败（如权限不足）不再打断 UI：错误进日志面板，树内以红色占位行呈现
  ipcMain.handle(
    channels.sftpList,
    async (_e, { hostId, path }: { hostId: string; path: string }) => {
      try {
        return await sftpOf(hostId).list(path)
      } catch (err) {
        appLog('sftp', `List directory "${path}" failed: ${errorMessage(err)}`, 'error')
        throw err
      }
    }
  )

  ipcMain.handle(channels.sftpRealpath, (_e, { hostId, path }: { hostId: string; path: string }) =>
    sftpOf(hostId).realpath(path)
  )

  ipcMain.handle(channels.sftpReadlink, (_e, { hostId, path }: { hostId: string; path: string }) =>
    sftpOf(hostId).readlink(path)
  )

  ipcMain.handle(
    channels.sftpItemDetail,
    (_e, { hostId, path }: { hostId: string; path: string }) => sftpOf(hostId).itemDetail(path)
  )

  ipcMain.handle(channels.sftpExists, (_e, { hostId, path }: { hostId: string; path: string }) =>
    sftpOf(hostId).exists(path)
  )

  ipcMain.handle(
    channels.sftpIsDirectory,
    (_e, { hostId, path }: { hostId: string; path: string }) => sftpOf(hostId).isDirectory(path)
  )

  ipcMain.handle(channels.sftpMkdir, (_e, { hostId, path }: { hostId: string; path: string }) =>
    sftpOf(hostId).mkdir(path)
  )

  ipcMain.handle(channels.sftpTouch, (_e, { hostId, path }: { hostId: string; path: string }) =>
    sftpOf(hostId).touch(path)
  )

  ipcMain.handle(
    channels.sftpRename,
    (_e, { hostId, src, dest }: { hostId: string; src: string; dest: string }) =>
      sftpOf(hostId).rename(src, dest)
  )

  ipcMain.handle(
    channels.sftpChmod,
    (_e, { hostId, path, mode }: { hostId: string; path: string; mode: number }) =>
      sftpOf(hostId).chmod(path, mode)
  )

  ipcMain.handle(
    channels.sftpReadForEdit,
    (
      _e,
      {
        hostId,
        path,
        size,
        encoding
      }: { hostId: string; path: string; size: number; encoding?: EncodingMode }
    ) => sftpOf(hostId).readForEdit(path, size, encoding)
  )

  ipcMain.handle(
    channels.sftpWriteText,
    (
      _e,
      {
        hostId,
        path,
        text,
        encoding,
        bom
      }: { hostId: string; path: string; text: string; encoding?: FileEncoding; bom?: boolean }
    ) => sftpOf(hostId).writeText(path, text, encoding, bom)
  )

  ipcMain.handle(
    channels.sftpRemove,
    (_e, { hostId, entry }: { hostId: string; entry: SftpEntry }) => sftpOf(hostId).remove(entry)
  )

  // 传输为后台任务：进度/错误经 sftp:transfer 事件广播，invoke 立即返回
  ipcMain.handle(
    channels.sftpDownload,
    (_e, { hostId, entry }: { hostId: string; entry: SftpEntry }) => {
      void sftpOf(hostId)
        .download(entry)
        .catch(() => {})
    }
  )

  ipcMain.handle(
    channels.sftpUpload,
    (
      _e,
      { hostId, localPaths, destDir }: { hostId: string; localPaths: string[]; destDir: string }
    ) => {
      void sftpOf(hostId)
        .upload(localPaths, destDir)
        .catch(() => {})
    }
  )

  // 测量同后台：进度/结果经 sftp:measure 事件广播
  ipcMain.handle(channels.sftpMeasure, (_e, { hostId, path }: { hostId: string; path: string }) => {
    void sftpOf(hostId).measure(path)
  })

  ipcMain.on(channels.sftpMeasureCancel, (_e, hostId: string) => {
    sftpOf(hostId).abortMeasure()
  })

  // 取消对应传输的字节流和专用通道。
  ipcMain.on(
    'sftp:retryCleanup',
    (_e, { hostId, transferId }: { hostId: string; transferId: string }) => {
      void findTransferSession(hostId, transferId)?.retryCleanup(transferId)
    }
  )
  ipcMain.on(
    channels.sftpTransferCancel,
    (_e, { hostId, transferId }: { hostId: string; transferId: string }) => {
      findTransferSession(hostId, transferId)?.cancelTransfer(transferId)
    }
  )

  ipcMain.handle(channels.sftpPickLocal, (e, folders: boolean) => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined
    return pickLocalPaths(folders, parent)
  })

  ipcMain.handle(channels.sftpRevealDownloads, () => {
    shell.openPath(app.getPath('downloads'))
  })

  ipcMain.handle(
    channels.sftpRevealLocal,
    (_e, { path, isDir }: { path: string; isDir: boolean }) => {
      const root = resolvePath(app.getPath('downloads'))
      const resolved = resolvePath(path)
      if (resolved !== root && !resolved.startsWith(root + pathSep)) {
        throw new Error('path must be under downloads')
      }
      // 文件：打开所在目录并选中该文件；目录：直接打开该目录
      return isDir ? shell.openPath(resolved) : shell.showItemInFolder(resolved)
    }
  )

  ipcMain.handle(channels.localAccessOpenSettings, (_e, folder: ProtectedFolder) => {
    openFolderPrivacySettings(folder)
  })
}
