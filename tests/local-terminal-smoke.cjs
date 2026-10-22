const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
app.on('window-all-closed', () => {})
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deadline = setTimeout(() => {
  console.error('Local terminal smoke timed out')
  app.exit(1)
}, 25000)

app
  .whenReady()
  .then(async () => {
    const bundle = path.resolve('node_modules/.cache/local-terminal-smoke.cjs')
    fs.mkdirSync(path.dirname(bundle), { recursive: true })
    require('esbuild').buildSync({
      entryPoints: ['src/main/localTerminal.ts'],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      logLevel: 'silent'
    })
    const { registerLocalTerminalIpc, installLocalTerminals, disposeLocalTerminals } = require(
      bundle
    )
    registerLocalTerminalIpc()
    const window = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    })
    installLocalTerminals(window.webContents)
    await window.loadURL('about:blank')
    await window.webContents.executeJavaScript(`
    globalThis.ipc = require('electron').ipcRenderer;
    globalThis.output = {}; globalThis.exits = {};
    ipc.on('local-terminal:event', (_event, event) => {
      if (event.type === 'data') output[event.id] = (output[event.id] || '') + event.data;
      else exits[event.id] = event.exitCode;
    });
    void 0;
  `)
    const invoke = (action, ...args) =>
      window.webContents.executeJavaScript(
        `ipc.invoke(${JSON.stringify(`local-terminal:${action}`)}, ...${JSON.stringify(args)})`
      )
    const read = (id) => window.webContents.executeJavaScript(`output[${JSON.stringify(id)}] || ''`)
    async function waitOutput(id, pattern) {
      const end = Date.now() + 5000
      let text = ''
      while (Date.now() < end) {
        text = await read(id)
        if (pattern.test(text)) return text
        await delay(40)
      }
      throw new Error(`Missing ${pattern}: ${text}`)
    }
    const win = process.platform === 'win32'
    const first = await invoke('create')
    const second = await invoke('create')
    assert.notEqual(first.id, second.id)
    await invoke('ready', first.id)
    await invoke('ready', second.id)
    await invoke('resize', first.id, 101, 37)
    await invoke(
      'write',
      first.id,
      win
        ? `Write-Output ('LOCAL_' + (40+2) + '_中文'); Write-Output ('PID_' + $PID)\r`
        : `printf 'LOCAL_%s_中文\\nPID_%s\\n' "$((40+2))" "$$"\r`
    )
    const output = await waitOutput(first.id, /LOCAL_42_中文/)
    assert.ok(!/LOCAL_42_中文/.test(await read(second.id)), 'session output must stay isolated')
    if (!win) {
      await invoke('write', first.id, 'stty size\r')
      await waitOutput(first.id, /37 101/)
      await invoke('write', first.id, 'sleep 30\r')
      await delay(100)
      await invoke('write', first.id, '\x03')
      await invoke('write', first.id, `printf 'AFTER_%s\\n' "$((20+2))"\r`)
      await waitOutput(first.id, /AFTER_22/)
    }
    await invoke('write', second.id, 'exit 7\r')
    const end = Date.now() + 5000
    while (
      Date.now() < end &&
      (await window.webContents.executeJavaScript(`exits[${JSON.stringify(second.id)}]`)) !== 7
    )
      await delay(40)
    assert.equal(
      await window.webContents.executeJavaScript(`exits[${JSON.stringify(second.id)}]`),
      7
    )
    await invoke('close', second.id)
    const pid = Number((output.match(/PID_(\d+)/) || [])[1])
    assert.ok(pid > 0)
    window.destroy()
    disposeLocalTerminals()
    let gone = false
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0)
      } catch {
        gone = true
        break
      }
      await delay(40)
    }
    assert.ok(gone, 'destroying the window must stop its shell')
    clearTimeout(deadline)
    console.log(
      'Local terminal smoke passed: input, Chinese output, resize, Ctrl-C, isolation, exit and cleanup'
    )
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
