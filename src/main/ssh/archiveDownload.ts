import { createWriteStream } from 'node:fs'
import { PassThrough, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { utilityProcess } from 'electron'
import { join } from 'node:path'
import type { TransferTask } from './transferTask'

/** The pipeline owns only local streams; remote _destroy / close cannot hold it open. */
export async function receiveArchive(
  source: Readable,
  file: string,
  task: TransferTask,
  progress: (bytes: number) => void
): Promise<void> {
  const bridge = new PassThrough()
  let bytes = 0
  const onData = (chunk: Buffer): void => {
    bytes += chunk.length
    progress(bytes)
  }
  const onError = (error: Error): void => {
    bridge.destroy(error)
  }
  const onClose = (): void => {
    if (!source.readableEnded) bridge.destroy(new Error('Archive stream closed prematurely'))
  }
  source.on('error', onError)
  source.on('close', onClose)
  bridge.on('data', onData)
  const writing = pipeline(bridge, createWriteStream(file, { flags: 'wx' }), {
    signal: task.signal
  })
  source.pipe(bridge)
  try {
    await writing
  } finally {
    source.unpipe(bridge)
    source.off('close', onClose)
    // Retain the error listener: late errors from SSH teardown must stay handled.
    if (task.signal.aborted || !source.readableEnded) source.destroy()
  }
}

export async function extractArchive(
  file: string,
  dest: string,
  task: TransferTask
): Promise<void> {
  task.signal.throwIfAborted()
  const child = utilityProcess.fork(join(__dirname, 'tarWorker.js'), [file, dest], {
    stdio: 'pipe'
  })
  let diagnostic = ''
  child.stderr?.on('data', (data: Buffer) => {
    diagnostic = (diagnostic + data.toString()).slice(-4096)
  })
  child.stdout?.resume()
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      child.kill()
    }
    child.once('spawn', () => {
      if (task.signal.aborted) abort()
    })
    child.once('exit', (code) => {
      task.signal.removeEventListener('abort', abort)
      if (task.signal.aborted) reject(new Error('Transfer canceled'))
      else if (code === 0) resolve()
      else reject(new Error(diagnostic || `Archive extraction exited: ${code}`))
    })
    task.signal.addEventListener('abort', abort, { once: true })
    if (task.signal.aborted) abort()
  })
}
