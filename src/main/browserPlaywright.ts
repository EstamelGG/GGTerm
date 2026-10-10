import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { browserProtocol, redactBrowserResult } from './browserAutomation'

type Packet = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }
const dialogs = new WeakMap<
  WebContents,
  (accept: boolean, promptText?: string) => Promise<unknown>
>()
export async function replyPlaywrightDialog(
  wc: WebContents,
  accept: boolean,
  promptText?: string
): Promise<unknown> {
  const reply = dialogs.get(wc)
  if (!reply) throw new Error('No pending Playwright dialog')
  return reply(accept, promptText)
}

/** A tab-scoped CDP transport, following VS Code's virtual Browser/Target proxy.
 * No debugging port is opened and unrelated application pages are not exposed.
 */
export async function runPlaywright(
  wc: WebContents,
  code: string,
  timeoutMs = 10000,
  signal?: AbortSignal
): Promise<unknown> {
  signal?.throwIfAborted()
  if (dialogs.has(wc)) throw new Error('A dialog is waiting; use handle_dialog before continuing')
  return browserProtocol(wc, async (send) => {
    const { targetInfo } = (await send('Target.getTargetInfo', {})) as {
      targetInfo: Record<string, unknown>
    }
    const targetId = targetInfo.targetId as string
    const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })) as {
      sessionId: string
    }
    const worker = new Worker(join(__dirname, 'browserPlaywrightWorker.js'), {
      workerData: { code, timeoutMs }
    })
    const childSessions = new Set<string>([sessionId])
    let attached = false
    return new Promise((resolve, reject) => {
      let deliver = resolve
      let fail = reject
      let finished = false
      const reply = (message: unknown): void => {
        if (!finished) worker.postMessage({ type: 'cdp', message })
      }
      const event = (
        _event: Electron.Event,
        method: string,
        params: Record<string, unknown>,
        sid?: string
      ): void => {
        if (!sid || !childSessions.has(sid)) return
        if (method === 'Target.attachedToTarget') childSessions.add(params.sessionId as string)
        reply({ method, params, sessionId: sid })
      }
      const finish = (error?: Error, result?: unknown): void => {
        if (finished) return
        finished = true
        dialogs.delete(wc)
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        wc.removeListener('destroyed', closed)
        wc.debugger.removeListener('message', event)
        void worker.terminate()
        if (!wc.isDestroyed()) void send('Target.detachFromTarget', { sessionId }).catch(() => {})
        if (error) fail(new Error(redactBrowserResult(wc, error.message)))
        else deliver(redactBrowserResult(wc, result))
      }
      const abort = (): void => finish(new Error('Playwright execution cancelled'))
      const closed = (): void => finish(new Error('Browser tab closed'))
      let timer = setTimeout(
        () =>
          finish(
            new Error(
              'Playwright execution timed out and was stopped; inspect the page before retrying'
            )
          ),
        timeoutMs + 10000
      )
      signal?.addEventListener('abort', abort, { once: true })
      wc.once('destroyed', closed)
      wc.debugger.on('message', event)
      worker.on('error', (error) => finish(error))
      worker.on('exit', () => {
        if (!finished) finish(new Error('Playwright worker stopped'))
      })
      worker.on('message', async (message) => {
        if (message.type === 'result') {
          finish(undefined, { result: message.result, logs: message.logs })
          return
        }
        if (message.type === 'error') {
          finish(new Error(message.error))
          return
        }
        if (message.type === 'dialog') {
          clearTimeout(timer)
          timer = setTimeout(() => finish(new Error('Dialog expired')), 300000)
          dialogs.set(
            wc,
            (accept, promptText) =>
              new Promise((resolveDialog, rejectDialog) => {
                deliver = resolveDialog
                fail = rejectDialog
                clearTimeout(timer)
                timer = setTimeout(
                  () => finish(new Error('Playwright execution timed out after dialog')),
                  timeoutMs
                )
                void wc.debugger
                  .sendCommand('Page.handleJavaScriptDialog', { accept, promptText }, sessionId)
                  .catch((error) => finish(error))
              })
          )
          deliver(
            redactBrowserResult(wc, {
              dialog: message.dialog,
              interrupted: true,
              note: 'Handle the dialog before continuing; do not repeat the initiating action.'
            })
          )
          return
        }
        if (message.type !== 'cdp') return
        const packet = message.message as Packet
        try {
          let result: unknown = {}
          if (packet.sessionId) {
            if (!childSessions.has(packet.sessionId)) throw new Error('Unknown page session')
            result = await wc.debugger.sendCommand(
              packet.method,
              packet.params ?? {},
              packet.sessionId
            )
          } else {
            switch (packet.method) {
              case 'Browser.getVersion':
                result = await send('Browser.getVersion', {})
                break
              case 'Target.getTargetInfo':
                result = { targetInfo }
                break
              case 'Target.getTargets':
                result = { targetInfos: [targetInfo] }
                break
              case 'Target.getBrowserContexts':
                result = { browserContextIds: [] }
                break
              case 'Target.setAutoAttach':
                if (!attached) {
                  attached = true
                  reply({
                    method: 'Target.attachedToTarget',
                    params: {
                      sessionId,
                      targetInfo: { ...targetInfo, type: 'page', browserContextId: 'aterm-tab' },
                      waitingForDebugger: false
                    }
                  })
                }
                break
              case 'Target.setDiscoverTargets':
              case 'Browser.setDownloadBehavior':
              case 'Browser.close':
                break
              default:
                throw new Error(
                  `Unsupported browser-level operation: ${packet.method}; use the app browser tools to manage tabs`
                )
            }
          }
          reply({ id: packet.id, result: result ?? {}, sessionId: packet.sessionId })
        } catch (error) {
          reply({
            id: packet.id,
            error: { code: -32000, message: String((error as Error).message) },
            sessionId: packet.sessionId
          })
        }
      })
    })
  })
}
