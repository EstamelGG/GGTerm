import { errorMessage } from '../../shared/error'
import type { SftpEntry } from '../../shared/types'
import { appLog } from '../log'
import type { HostLinkEvents } from './link'
export class DirectoryMeasure {
  private measureAbort: AbortController | null = null
  private measureQueue: string[] | null = null
  constructor(
    private readonly hostId: string,
    private readonly listEntries: (path: string) => Promise<SftpEntry[]>,
    private readonly onMeasure: HostLinkEvents['onSftpMeasure']
  ) {}

  /* ---------------- 目录测量（对照 measureDirectory，120ms 节流 + 可取消） ---------------- */

  async measure(path: string): Promise<void> {
    this.abortMeasure()
    const abort = new AbortController()
    this.measureAbort = abort
    const hostId = this.hostId
    let last = 0
    const acc = { bytes: 0, files: 0, dirs: 0, skipped: 0, skippedPaths: [] as string[] }
    const emit = (done: boolean, error?: string): void => {
      if (abort.signal.aborted) return
      this.onMeasure({ hostId, path, ...acc, done, error })
    }
    try {
      await this.accumulate(path, acc, abort.signal, () => {
        const now = Date.now()
        if (now - last >= 120) {
          last = now
          emit(false)
        }
      })
      emit(true)
    } catch (err) {
      if (abort.signal.aborted) return
      appLog('sftp', `Measure "${path}" failed: ${errorMessage(err)}`, 'error')
      emit(true, errorMessage(err))
    }
  }

  /**
   * 目录测量（对照 measureDirectory，120ms 节流 + 可取消）。
   * 并发遍历：任务队列 + 32 个 worker（SFTP 单通道支持多请求在途）。
   * 错误语义对齐 du：根目录不可读 → 整体失败；子目录不可读（如 root
   * 属主的 0700 目录）→ 计入 skipped 并继续测量其余部分。
   */
  private static readonly MEASURE_CONCURRENCY = 32

  private async accumulate(
    root: string,
    acc: { bytes: number; files: number; dirs: number; skipped: number; skippedPaths: string[] },
    signal: AbortSignal,
    progress: () => void
  ): Promise<void> {
    const queue: string[] = [root]
    this.measureQueue = queue
    let failed = false
    const worker = async (): Promise<void> => {
      while (!failed && queue.length > 0) {
        if (signal.aborted) throw new Error('aborted')
        const dir = queue.shift()
        if (dir === undefined) break
        let kids: SftpEntry[]
        try {
          kids = await this.listEntries(dir)
        } catch (err) {
          if (signal.aborted) throw new Error('aborted')
          if (dir === root) throw err
          acc.skipped += 1
          if (acc.skippedPaths.length < 5) acc.skippedPaths.push(dir.split('/').pop() || dir)
          appLog(
            'sftp',
            `Measure skipped unreadable directory "${dir}": ${errorMessage(err)}`,
            'error'
          )
          progress()
          continue
        }
        for (const kid of kids) {
          if (signal.aborted) throw new Error('aborted')
          if (kid.isDir) {
            acc.dirs += 1
            queue.push(kid.path)
          } else {
            acc.files += 1
            acc.bytes += kid.size
          }
          progress()
        }
      }
    }
    try {
      const workers = Array.from({ length: DirectoryMeasure.MEASURE_CONCURRENCY }, () =>
        worker().catch((err: unknown) => {
          failed = true // 首个失败清场：其余 worker 快速退出，错误向上冒泡
          queue.length = 0
          throw err
        })
      )
      await Promise.all(workers)
    } finally {
      if (this.measureQueue === queue) this.measureQueue = null
    }
  }

  abortMeasure(): void {
    this.measureAbort?.abort()
    this.measureAbort = null
    // 硬止损：清空任务队列，所有 worker 在当前在途 readdir 返回后立即退出，
    // 不再发起新请求（ssh2 无按请求取消 API，在途 ≤ 并发数且只含 readdir）
    if (this.measureQueue !== null) {
      this.measureQueue.length = 0
      this.measureQueue = null
      appLog('sftp', 'Directory measurement canceled')
    }
  }
}
