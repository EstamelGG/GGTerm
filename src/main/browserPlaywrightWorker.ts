import { parentPort, workerData } from 'node:worker_threads'
import { createContext, Script } from 'node:vm'
import { chromium, type ConnectOverCDPTransport } from 'playwright-core'

// Same page-based execution model as VS Code's Playwright service, in a worker
// so an infinite loop or unresolved operation can be stopped without blocking Electron.
const port = parentPort!
const transport: ConnectOverCDPTransport = {
  send: (message) => port.postMessage({ type: 'cdp', message }),
  close: () => {},
  onmessage: undefined,
  onclose: undefined
}
port.on('message', (message) => {
  if (message.type === 'cdp') transport.onmessage?.(message.message)
})
void (async () => {
  const browser = await chromium.connectOverCDP(transport, { timeout: 10000 })
  const page = browser.contexts()[0]?.pages()[0]
  if (!page) throw new Error('Browser page is unavailable')
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  if (!viewport.width || !viewport.height) await page.setViewportSize({ width: 1280, height: 800 })
  page.setDefaultTimeout(workerData.timeoutMs)
  page.setDefaultNavigationTimeout(workerData.timeoutMs)
  const logs: string[] = []
  page.on('console', (event) => {
    if (logs.length < 30) logs.push(`[${event.type()}] ${event.text().slice(0, 1000)}`)
  })
  page.on('pageerror', (error) => {
    if (logs.length < 30) logs.push(error.message.slice(0, 1000))
  })
  page.on('dialog', (dialog) => {
    port.postMessage({
      type: 'dialog',
      dialog: {
        type: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue()
      }
    })
  })
  const context = createContext({
    page,
    console: {
      log: (...values: unknown[]) => {
        if (logs.length < 30) logs.push(values.map(String).join(' ').slice(0, 1000))
      }
    }
  })
  const result = await new Script(`(async () => { ${workerData.code}\n })()`).runInContext(
    context,
    { timeout: 1000 }
  )
  const serialized = JSON.stringify(result ?? null)
  port.postMessage({
    type: 'result',
    result:
      serialized.length > 24000
        ? { truncated: true, text: serialized.slice(0, 24000) }
        : JSON.parse(serialized),
    logs
  })
})().catch((error) =>
  port.postMessage({ type: 'error', error: String(error?.message ?? error).slice(0, 12000) })
)
