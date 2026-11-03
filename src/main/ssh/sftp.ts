import { app, dialog, shell } from 'electron'
import { createReadStream, createWriteStream, promises as fsp } from 'fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { basename, join as joinLocal, parse } from 'path'
import type { Client, SFTPWrapper } from 'ssh2'
import { errorMessage } from '../../shared/error'
import { joinPath, shellQuote } from '../../shared/sftpPath'
import type { SftpEntry, SftpStateEvent, SftpTransferMirror } from '../../shared/types'
import { localAccessDeniedError } from '../localAccess'
import { appLog } from '../log'
import { extractArchive, receiveArchive } from './archiveDownload'
import { DirectoryMeasure } from './directoryMeasure'
import type { HostLink, HostLinkEvents } from './link'
import { ResourceLifetime } from './resourceLifetime'
import { SftpFiles, entryFrom, type SftpStats, type SftpFileEntry } from './sftpFiles'
import { TransferTask } from './transferTask'
export { execCommand } from './sftpFiles'

/**
 * 对照 ATerminal-Swift Services/SftpController.swift：
 * - 挂在主机共享 SSH 连接上开 SFTP 通道；断线由主机级信号统一驱动（无自主重连）
 * - 树状态（children 缓存/expanded/显隐）留在渲染层 —— 本类只做无状态操作
 * - 传输用 ssh2 fastGet/fastPut（step 回调累计进度，对照手写 chunk 循环）
 */

type SftpEvents = Pick<HostLinkEvents, 'onSftpState' | 'onSftpTransfer' | 'onSftpMeasure'>

/** 统一 ssh2 回调风格（err 可为 undefined）为 Promise */
function p<T>(fn: (cb: (err: Error | null | undefined, res?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, res) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)))
      else resolve(res as T)
    })
  })
}

export class SftpSession {
  private readonly files: SftpFiles
  private readonly measurement: DirectoryMeasure
  private sftp: SFTPWrapper | null = null
  private started = false
  private transfers: SftpTransferMirror[] = []
  /** 进度采样基准（速度差值）：xfer.id → {at, bytes} */
  private tickAt = new Map<string, { at: number; bytes: number }>()
  /** 进度事件节流标记：xfer.id → 上次 emit 时刻 */
  private lastEmitAt = new Map<string, number>()
  private readonly tasks = new Map<string, TransferTask>()
  private readonly cleanupPaths = new Map<string, Set<string>>()
  private readonly cleaning = new Set<string>()

  private queueCleanup(xfer: SftpTransferMirror, path: string): void {
    const paths = this.cleanupPaths.get(xfer.id) ?? new Set<string>()
    paths.add(path)
    this.cleanupPaths.set(xfer.id, paths)
  }

  hasTransfer(id: string): boolean {
    return this.transfers.some((transfer) => transfer.id === id)
  }

  async retryCleanup(id: string): Promise<void> {
    const paths = this.cleanupPaths.get(id)
    const xfer = this.transfers.find((item) => item.id === id)
    if (!paths?.size || !xfer || this.cleaning.has(id)) return
    this.cleaning.add(id)
    xfer.cleanup = 'pending'
    xfer.cleanupError = undefined
    const emit = (): void =>
      this.events.onSftpTransfer({ hostId: this.link.hostId, transfer: { ...xfer } })
    emit()
    const errors: string[] = []
    for (const path of paths) {
      try {
        await fsp.rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
        paths.delete(path)
      } catch (error) {
        errors.push(`${path}: ${errorMessage(error)}`)
      }
    }
    this.cleaning.delete(id)
    xfer.cleanup = errors.length ? 'error' : undefined
    xfer.cleanupError = errors.length ? errors.join('\n') : undefined
    if (!paths.size) this.cleanupPaths.delete(id)
    emit()
  }
  private channelLock: Promise<SFTPWrapper> | null = null
  private readonly channelLifetime: ResourceLifetime

  constructor(
    private readonly link: HostLink,
    private readonly events: SftpEvents
  ) {
    this.channelLifetime = new ResourceLifetime(link.hostId, 'sftp')
    this.files = new SftpFiles(
      () => this.ensureChannel(),
      (channel, fn) => this.request(channel, fn),
      () => this.client,
      this.channelLifetime
    )
    this.measurement = new DirectoryMeasure(
      link.hostId,
      (path) => this.files.listEntries(path),
      (event) => this.events.onSftpMeasure(event)
    )
  }

  /** 渲染层面板激活时调用：链路未活则等待（≤15s），再开通道 —— 首连事件竞态兜底 */
  async start(): Promise<void> {
    this.started = true
    const lifetime = this.channelLifetime.capture(this.client)
    if (!this.client) {
      try {
        await this.link.waitForActive()
      } catch (error) {
        if (lifetime.signal.aborted) return
        throw error
      }
    }
    if (lifetime.signal.aborted || !this.started) return
    await this.ensureChannel()
  }

  stop(): void {
    this.started = false
    this.abortMeasure()
    this.teardown()
  }

  /** 主机链路丢失 —— 通道作废；恢复仅由 hostLinkRestored 驱动 */
  hostLinkLost(): void {
    this.teardown()
    this.emitState('disconnected')
  }

  /** 主机链路（重）建立 —— 重开通道；目录刷新由渲染层监听 host:state 驱动 */
  hostLinkRestored(): void {
    if (!this.started) return
    void this.ensureChannel().catch(() => {})
  }

  /* ---------------- 通道 ---------------- */

  private get client(): Client | null {
    return this.link.activeClient
  }

  private async ensureChannel(): Promise<SFTPWrapper> {
    if (this.sftp) return this.sftp
    if (this.channelLock) return this.channelLock
    const client = this.client
    if (!client) throw new Error('host link not active')
    this.emitState('connecting')
    const lifetime = this.channelLifetime.capture(this.client)
    const opening = this.request<SFTPWrapper>(null, (cb) =>
      client.sftp((error, channel) => {
        if (lifetime.signal.aborted || client !== this.client) {
          channel?.destroy()
          cb(new Error('SFTP connection changed; retry the operation'))
        } else cb(error, channel)
      })
    )
      .then((sftp) => {
        if (!lifetime.current()) {
          sftp.destroy()
          throw new Error('SFTP connection changed; retry the operation')
        }
        this.sftp = sftp
        const lost = (): void => {
          if (this.sftp !== sftp) return
          this.teardown()
          this.emitState('disconnected')
        }
        sftp.once('close', lost)
        sftp.once('end', lost)
        sftp.on('error', lost)
        this.emitState('connected')
        return sftp
      })
      .catch((err: Error) => {
        if (lifetime.current()) {
          this.teardown()
          this.emitState('error', err.message)
        }
        throw err
      })
      .finally(() => {
        if (this.channelLock === opening) this.channelLock = null
      })
    this.channelLock = opening
    return opening
  }

  /** Bound callback requests to the current channel, including Agent-only sessions. */
  private request<T>(
    channel: SFTPWrapper | null,
    fn: (cb: (err: Error | null | undefined, res?: T) => void) => void
  ): Promise<T> {
    const lifetime = this.channelLifetime.capture(this.client)
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (err?: Error | null, value?: T): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        lifetime.signal.removeEventListener('abort', abort)
        if (err) reject(err)
        else resolve(value as T)
      }
      const abort = (): void => finish(new Error('SFTP connection lost; retry after reconnecting'))
      const timer = setTimeout(() => {
        finish(new Error('SFTP request timed out after 30 seconds; retry to reopen the channel'))
        if (lifetime.current()) this.teardown()
      }, 30000)
      lifetime.signal.addEventListener('abort', abort, { once: true })
      if (!lifetime.current() || (channel && channel !== this.sftp)) {
        abort()
        return
      }
      try {
        fn((err, value) =>
          finish(err ? (err instanceof Error ? err : new Error(errorMessage(err))) : null, value)
        )
      } catch (err) {
        finish(new Error(errorMessage(err)))
      }
    })
  }

  private teardown(): void {
    this.abortMeasure()
    const current = this.sftp
    this.sftp = null
    this.channelLock = null
    this.files.clearCache()
    this.channelLifetime.reset()
    for (const task of this.tasks.values()) task.cancel()
    if (current) {
      try {
        current.destroy()
      } catch {
        /* ignore */
      }
    }
  }

  private emitState(status: SftpStateEvent['status'], error?: string): void {
    this.events.onSftpState({
      hostId: this.link.hostId,
      status,
      error,
      resource: this.channelLifetime.capture(this.client).identity
    })
  }
  list(...args: Parameters<SftpFiles['list']>): ReturnType<SftpFiles['list']> {
    return this.files.list(...args)
  }

  realpath(...args: Parameters<SftpFiles['realpath']>): ReturnType<SftpFiles['realpath']> {
    return this.files.realpath(...args)
  }

  readlink(...args: Parameters<SftpFiles['readlink']>): ReturnType<SftpFiles['readlink']> {
    return this.files.readlink(...args)
  }

  stat(...args: Parameters<SftpFiles['stat']>): ReturnType<SftpFiles['stat']> {
    return this.files.stat(...args)
  }

  itemDetail(...args: Parameters<SftpFiles['itemDetail']>): ReturnType<SftpFiles['itemDetail']> {
    return this.files.itemDetail(...args)
  }

  exists(...args: Parameters<SftpFiles['exists']>): ReturnType<SftpFiles['exists']> {
    return this.files.exists(...args)
  }

  isDirectory(...args: Parameters<SftpFiles['isDirectory']>): ReturnType<SftpFiles['isDirectory']> {
    return this.files.isDirectory(...args)
  }

  mkdir(...args: Parameters<SftpFiles['mkdir']>): ReturnType<SftpFiles['mkdir']> {
    return this.files.mkdir(...args)
  }

  touch(...args: Parameters<SftpFiles['touch']>): ReturnType<SftpFiles['touch']> {
    return this.files.touch(...args)
  }

  rename(...args: Parameters<SftpFiles['rename']>): ReturnType<SftpFiles['rename']> {
    return this.files.rename(...args)
  }

  chmod(...args: Parameters<SftpFiles['chmod']>): ReturnType<SftpFiles['chmod']> {
    return this.files.chmod(...args)
  }

  readForEdit(...args: Parameters<SftpFiles['readForEdit']>): ReturnType<SftpFiles['readForEdit']> {
    return this.files.readForEdit(...args)
  }

  writeText(...args: Parameters<SftpFiles['writeText']>): ReturnType<SftpFiles['writeText']> {
    return this.files.writeText(...args)
  }

  unlink(...args: Parameters<SftpFiles['unlink']>): ReturnType<SftpFiles['unlink']> {
    return this.files.unlink(...args)
  }

  remove(...args: Parameters<SftpFiles['remove']>): ReturnType<SftpFiles['remove']> {
    return this.files.remove(...args)
  }

  /* ---------------- 传输（对照 upload/download + SftpTransfer） ---------------- */

  async upload(localPaths: string[], destDir: string): Promise<void> {
    for (const local of localPaths) {
      const xfer = this.beginTransfer(basename(local), 'up', 0)
      const completed = await this.runTransfer(xfer, async (task) => {
        const sftp = await this.transferChannel(task)
        await this.uploadItem(
          local,
          joinPath(destDir, basename(local)),
          xfer,
          task,
          sftp,
          new Set()
        )
      })
      if (!completed) {
        if (xfer.status === 'canceled') throw new Error('Transfer canceled')
        throw new Error(xfer.error ?? `Upload failed: ${basename(local)}`)
      }
    }
  }

  private async uploadItem(
    local: string,
    remote: string,
    xfer: SftpTransferMirror,
    task: TransferTask,
    sftp: SFTPWrapper,
    ancestors: Set<string>
  ): Promise<void> {
    task.signal.throwIfAborted()
    let st: Awaited<ReturnType<typeof fsp.stat>>
    try {
      st = await fsp.stat(local)
    } catch (err) {
      const access = localAccessDeniedError(local, err)
      if (access) {
        xfer.accessDenied = { folder: access.folder, path: access.path }
        throw access
      }
      throw err
    }
    if (st.isDirectory()) {
      const canonical = await fsp.realpath(local)
      if (ancestors.has(canonical)) throw new Error(`Directory symlink cycle: ${local}`)
      const next = new Set(ancestors).add(canonical)
      try {
        await p((cb) => sftp.mkdir(remote, cb))
      } catch (err) {
        const existing = await p<SftpStats>((cb) => sftp.stat(remote, cb))
        if ((existing.mode & 0o170000) !== 0o040000) throw err
      }
      const kids = await fsp.readdir(local, { withFileTypes: true })
      for (const kid of kids) {
        task.signal.throwIfAborted()
        await this.uploadItem(
          joinLocal(local, kid.name),
          joinPath(remote, kid.name),
          xfer,
          task,
          sftp,
          next
        )
      }
      return
    }
    if (!st.isFile()) throw new Error(`Unsupported file type: ${local}`)
    task.signal.throwIfAborted()
    xfer.total += st.size
    try {
      await pipeline(
        createReadStream(local),
        this.transferMeter(xfer),
        sftp.createWriteStream(remote),
        { signal: task.signal }
      )
    } catch (err) {
      const access = localAccessDeniedError(local, err)
      if (access) {
        xfer.accessDenied = { folder: access.folder, path: access.path }
        throw access
      }
      throw err
    }
  }

  async download(
    entry: SftpEntry,
    destDir?: string,
    opts?: { reveal?: boolean }
  ): Promise<string | undefined> {
    const xfer = this.beginTransfer(entry.name, 'down', entry.size)
    const folder = destDir ?? app.getPath('downloads')
    if (destDir) await fsp.mkdir(destDir, { recursive: true })
    let dest: string | undefined
    const completed = await this.runTransfer(xfer, async (task) => {
      dest = await uniqueLocal(joinLocal(folder, entry.name))
      task.signal.throwIfAborted()
      let owned = false
      try {
        if (entry.isDir) {
          await fsp.mkdir(dest)
          owned = true
          await this.downloadDir(entry, dest, folder, xfer, task)
        } else {
          await this.ensureDiskSpace(folder, entry.size)
          const sftp = await this.transferChannel(task)
          await this.downloadFileTo(entry.path, dest, xfer, task, sftp, () => {
            owned = true
          })
        }
      } catch (err) {
        if (owned) this.queueCleanup(xfer, dest)
        throw err
      }
    })
    if (completed && dest && (opts?.reveal ?? true)) shell.showItemInFolder(dest)
    return completed ? dest : undefined
  }

  /** 目录下载：整个目录 = 一个任务；有 tar 走打包单流，无 tar 回退递归逐文件。先算总量/文件数并预检磁盘，失败清理半成品 */
  private async downloadDir(
    entry: SftpEntry,
    dest: string,
    folder: string,
    xfer: SftpTransferMirror,
    task: TransferTask
  ): Promise<void> {
    const client = this.client
    if (!client) throw new Error('host link not active')
    const hasTar = (await this.taskExec(task, 'command -v tar')).trim() !== ''
    try {
      if (hasTar) {
        const total = await this.dirSize(entry.path, task)
        await this.ensureDiskSpace(folder, total * 2)
        xfer.total = total
        task.signal.throwIfAborted()
        await this.downloadDirViaTar(entry, dest, xfer, client, task)
      } else {
        const sftp = await this.transferChannel(task)
        const count = await this.countDir(entry.path, task, sftp)
        await this.ensureDiskSpace(folder, count.bytes)
        xfer.total = count.bytes
        xfer.totalFiles = count.files
        xfer.files = 0
        await this.downloadDirRecursive(entry.path, dest, xfer, task, sftp)
      }
    } catch (err) {
      // 失败（含磁盘空间不足/中途写满）清理半成品目录
      this.queueCleanup(xfer, dest)
      throw err
    }
  }

  /** 目录总字节数（du -sb，纯 tar 不压缩时近似总量）；失败返回 0（退化为不定态） */
  private async dirSize(path: string, task: TransferTask): Promise<number> {
    const client = this.client
    if (!client) return 0
    try {
      const out = await this.taskExec(task, `du -sb ${shellQuote(path)}`)
      const n = parseInt(out.trim().split(/\s+/)[0] ?? '', 10)
      return Number.isFinite(n) && n > 0 ? n : 0
    } catch {
      return 0
    }
  }

  /** 递归统计文件数与总字节（兜底下载的进度与磁盘预检用） */
  private async countDir(
    remote: string,
    task: TransferTask,
    sftp: SFTPWrapper
  ): Promise<{ files: number; bytes: number }> {
    task.signal.throwIfAborted()
    const kids = await this.transferEntries(remote, task, sftp)
    let files = 0
    let bytes = 0
    for (const kid of kids) {
      if (kid.isDir) {
        const sub = await this.countDir(kid.path, task, sftp)
        files += sub.files
        bytes += sub.bytes
      } else {
        files += 1
        bytes += kid.size
      }
    }
    return { files, bytes }
  }

  /** 磁盘空间预检：预期总大小超过本地可用空间则抛错 */
  private async ensureDiskSpace(folder: string, total: number): Promise<void> {
    if (total <= 0) return
    const st = await fsp.statfs(folder)
    const avail = st.bavail * st.bsize
    if (total > avail) throw new Error('Insufficient disk space')
  }

  /** 纯 tar（不压缩）：-C <dir> . 打包目录内容，经共享连接 exec 流式解包到 dest */
  private async downloadDirViaTar(
    entry: SftpEntry,
    dest: string,
    xfer: SftpTransferMirror,
    client: Client,
    task: TransferTask
  ): Promise<void> {
    const staging = await fsp.mkdtemp(joinLocal(app.getPath('downloads'), '.ggterm-'))
    this.queueCleanup(xfer, staging)
    const archive = joinLocal(staging, 'download.tar')
    const contents = joinLocal(staging, 'contents')
    await fsp.mkdir(contents)
    task.signal.throwIfAborted()
    const stream = await task.opening(
      p<import('ssh2').ClientChannel>((cb) =>
        client.exec(`tar cf - -C ${shellQuote(entry.path)} .`, cb)
      ),
      (s) => {
        try {
          s.signal('TERM')
        } catch {
          /* The remote may already have closed the command channel. */
        }
        s.destroy()
      }
    )
    let diagnostic = ''
    stream.stderr.on('data', (data: Buffer) => {
      diagnostic = (diagnostic + data.toString()).slice(-4096)
    })
    const exited = task.opening(
      new Promise<void>((resolve, reject) => {
        stream.once('close', (code: number | null) =>
          code === 0 ? resolve() : reject(new Error(diagnostic || `tar exited: ${code}`))
        )
        stream.once('error', reject)
      }),
      () => {}
    )
    xfer.phase = 'downloading'
    const receiving = receiveArchive(stream, archive, task, (bytes) =>
      this.tickTransfer(xfer, bytes)
    )
    try {
      await Promise.all([receiving, exited])
    } catch (error) {
      if (!task.signal.aborted) xfer.error = errorMessage(error)
      task.cancel()
      await receiving.catch(() => {})
      throw error
    }
    task.signal.throwIfAborted()
    xfer.phase = 'extracting'
    xfer.speed = 0
    this.events.onSftpTransfer({ hostId: this.link.hostId, transfer: { ...xfer } })
    await this.ensureDiskSpace(app.getPath('downloads'), xfer.total)
    await extractArchive(archive, contents, task)
    task.signal.throwIfAborted()
    await fsp.rmdir(dest)
    task.signal.throwIfAborted()
    await fsp.rename(contents, dest)
    task.signal.throwIfAborted()
  }

  /** 兜底：远端无 tar 时递归逐文件下载，字节累计进同一任务 */
  private async downloadDirRecursive(
    remote: string,
    local: string,
    xfer: SftpTransferMirror,
    task: TransferTask,
    sftp: SFTPWrapper
  ): Promise<void> {
    const kids = await this.transferEntries(remote, task, sftp)
    for (const kid of kids) {
      task.signal.throwIfAborted()
      const dest = joinLocal(local, kid.name)
      if (kid.isDir) {
        await fsp.mkdir(dest, { recursive: true })
        await this.downloadDirRecursive(kid.path, dest, xfer, task, sftp)
      } else {
        await this.downloadFileTo(kid.path, dest, xfer, task, sftp)
        xfer.files = (xfer.files ?? 0) + 1
        this.events.onSftpTransfer({ hostId: this.link.hostId, transfer: { ...xfer } })
      }
    }
  }

  /** 逐文件落盘，进度累计进父任务（目录兜底下载用；base = 已下载字节） */
  private async downloadFileTo(
    remote: string,
    local: string,
    xfer: SftpTransferMirror,
    task: TransferTask,
    sftp: SFTPWrapper,
    onCreated?: () => void
  ): Promise<void> {
    task.signal.throwIfAborted()
    const output = createWriteStream(local, { flags: 'wx' })
    output.once('open', () => onCreated?.())
    await pipeline(this.downloadChunks(remote, task, sftp), this.transferMeter(xfer), output, {
      signal: task.signal
    })
  }

  /** Avoid ssh2 ReadStream._destroy waiting forever for OPEN/CLOSE after channel abort. */
  private async *downloadChunks(
    remote: string,
    task: TransferTask,
    sftp: SFTPWrapper
  ): AsyncGenerator<Buffer> {
    const handle = await task.opening(
      p<Buffer>((cb) => sftp.open(remote, 'r', cb)),
      () => {}
    )
    try {
      let position = 0
      while (true) {
        task.signal.throwIfAborted()
        const buffer = Buffer.allocUnsafe(64 * 1024)
        const bytes = await task.opening(
          new Promise<number>((resolve, reject) => {
            sftp.read(handle, buffer, 0, buffer.length, position, (err, bytesRead) => {
              if (err) reject(err)
              else resolve(bytesRead)
            })
          }),
          () => {}
        )
        if (bytes === 0) break
        position += bytes
        yield buffer.subarray(0, bytes)
      }
    } finally {
      // Aborted tasks already destroy their dedicated SFTP channel (and its handles).
      if (!task.signal.aborted) {
        await task.opening(
          p<void>((cb) => sftp.close(handle, cb)),
          () => {}
        )
      }
    }
  }

  private async runTransfer(
    xfer: SftpTransferMirror,
    work: (task: TransferTask) => Promise<void>
  ): Promise<boolean> {
    const task = this.tasks.get(xfer.id)!
    try {
      await work(task)
      task.signal.throwIfAborted()
      this.endTransfer(xfer, 'done')
      return true
    } catch (err) {
      this.endTransfer(
        xfer,
        task.signal.aborted && !xfer.error ? 'canceled' : 'error',
        task.signal.aborted && !xfer.error ? undefined : errorMessage(err)
      )
      return false
    } finally {
      task.dispose()
      this.tasks.delete(xfer.id)
      await this.retryCleanup(xfer.id)
    }
  }

  private async transferChannel(task: TransferTask): Promise<SFTPWrapper> {
    task.signal.throwIfAborted()
    const client = this.client
    if (!client) throw new Error('host link not active')
    return task.opening(
      p<SFTPWrapper>((cb) => client.sftp(cb)),
      (sftp) => sftp.destroy()
    )
  }

  private async transferEntries(
    path: string,
    task: TransferTask,
    sftp: SFTPWrapper
  ): Promise<SftpEntry[]> {
    task.signal.throwIfAborted()
    const raw = await task.opening(
      p<SftpFileEntry[]>((cb) => sftp.readdir(path, cb)),
      () => {}
    )
    return raw
      .map((entry) => entryFrom(entry, path))
      .filter((entry): entry is SftpEntry => entry !== null)
  }

  private async taskExec(task: TransferTask, command: string): Promise<string> {
    task.signal.throwIfAborted()
    const client = this.client
    if (!client) throw new Error('host link not active')
    const stream = await task.opening(
      p<import('ssh2').ClientChannel>((cb) => client.exec(command, cb)),
      (s) => s.destroy()
    )
    return task.opening(
      new Promise<string>((resolve, reject) => {
        let output = ''
        stream.on('data', (data: Buffer) => {
          if (output.length < 65536) output += data.toString()
        })
        stream.stderr.resume()
        stream.once('close', () => resolve(output))
        stream.once('error', reject)
      }),
      () => {}
    )
  }

  private transferMeter(xfer: SftpTransferMirror): Transform {
    let bytes = xfer.bytes
    return new Transform({
      transform: (chunk: Buffer, _encoding, cb) => {
        bytes += chunk.length
        this.tickTransfer(xfer, bytes)
        cb(null, chunk)
      }
    })
  }

  /* ---------------- 传输镜像（对照 SftpTransfer + enqueue） ---------------- */

  private beginTransfer(
    name: string,
    direction: 'up' | 'down',
    total: number,
    totalFiles?: number
  ): SftpTransferMirror {
    const xfer: SftpTransferMirror = {
      id: crypto.randomUUID(),
      name,
      direction,
      status: 'running',
      bytes: 0,
      total,
      ...(totalFiles !== undefined ? { files: 0, totalFiles } : {})
    }
    this.tasks.set(xfer.id, new TransferTask())
    this.transfers = [
      xfer,
      ...this.transfers.filter((t) => t.status === 'running' || this.cleanupPaths.has(t.id)),
      ...this.transfers
        .filter((t) => t.status !== 'running' && !this.cleanupPaths.has(t.id))
        .slice(0, 23)
    ]
    this.events.onSftpTransfer({ hostId: this.link.hostId, transfer: { ...xfer } })
    appLog('sftp', `${direction === 'up' ? 'Upload' : 'Download'} "${name}" started`)
    return xfer
  }

  private tickTransfer(xfer: SftpTransferMirror, transferred: number): void {
    if (this.tasks.get(xfer.id)?.signal.aborted) return
    const prev = this.tickAt.get(xfer.id)
    const now = Date.now()
    // 瞬时速度：连续采样差值（每 tick 都更新基准，不因节流丢精度）
    if (prev && now > prev.at && transferred >= prev.bytes) {
      xfer.speed = Math.round(((transferred - prev.bytes) * 1000) / (now - prev.at))
    }
    xfer.bytes = transferred
    this.tickAt.set(xfer.id, { at: now, bytes: transferred })
    // step 回调每 chunk(32KB) 一次，不节流会 IPC 洪泛；最终值由 endTransfer 兜底
    if (now - (this.lastEmitAt.get(xfer.id) ?? 0) < 100) return
    this.lastEmitAt.set(xfer.id, now)
    this.events.onSftpTransfer({ hostId: this.link.hostId, transfer: { ...xfer } })
  }

  private endTransfer(
    xfer: SftpTransferMirror,
    status: 'done' | 'error' | 'canceled',
    error?: string
  ): void {
    xfer.status = status
    if (error) xfer.error = error
    this.tickAt.delete(xfer.id)
    this.lastEmitAt.delete(xfer.id)
    this.events.onSftpTransfer({ hostId: this.link.hostId, transfer: { ...xfer } })
    // 三点式日志：仅 开始/完成/失败/取消（不带耗时/速率），进度 tick 不记录
    const label = xfer.direction === 'up' ? 'Upload' : 'Download'
    if (status === 'done') {
      appLog('sftp', `${label} "${xfer.name}" completed`)
    } else if (status === 'canceled') {
      appLog('sftp', `${label} "${xfer.name}" canceled`)
    } else {
      appLog('sftp', `${label} "${xfer.name}" failed: ${error ?? 'unknown error'}`, 'error')
    }
  }

  /** Abort streams and the task's dedicated channel; report canceled after the operation unwinds. */
  cancelTransfer(transferId: string): void {
    const task = this.tasks.get(transferId)
    const xfer = this.transfers.find((item) => item.id === transferId)
    if (!task || !xfer || xfer.status !== 'running' || xfer.cancelRequested) return
    xfer.cancelRequested = true
    xfer.speed = 0
    task.cancel()
    this.events.onSftpTransfer({ hostId: this.link.hostId, transfer: { ...xfer } })
  }
  measure(path: string): Promise<void> {
    return this.measurement.measure(path)
  }

  abortMeasure(): void {
    this.measurement.abortMeasure()
  }
}

/** 本地选件（对照 pickUploadFiles/Folders；与具体会话无关） */
export async function pickLocalPaths(
  folders: boolean,
  parent?: Electron.BrowserWindow
): Promise<string[]> {
  const properties: Electron.OpenDialogOptions['properties'] = folders
    ? ['openDirectory', 'multiSelections']
    : ['openFile', 'multiSelections']
  const res = parent
    ? await dialog.showOpenDialog(parent, { properties })
    : await dialog.showOpenDialog({ properties })
  if (res.canceled) return []
  return res.filePaths
}

/** 下载目标重名自动加 "(n)"（对照 SftpController.unique） */
async function uniqueLocal(dest: string): Promise<string> {
  let candidate = dest
  let i = 1
  for (;;) {
    try {
      await fsp.access(candidate)
    } catch {
      return candidate
    }
    const { dir, name, ext } = parse(candidate)
    candidate = joinLocal(dir, `${name} (${i})${ext}`)
    i += 1
  }
}
