/* Runs the built UI with isolated data; update responses are fixtures, never live requests. */
const { app, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aterm-local-ui-'))
app.setPath('userData', root)
app.getVersion = () => '1.0.11'
fs.writeFileSync(
  path.join(root, 'preferences.json'),
  JSON.stringify({ locale: 'en', confirmCloseSession: true, perfMonitorDisabled: true })
)
const deadline = setTimeout(() => {
  console.error('Local terminal UI smoke timed out')
  app.exit(1)
}, 30000)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
app.whenReady().then(() => {
  session.defaultSession.protocol.handle('https', (request) => {
    assert.equal(request.url, 'https://api.github.com/repos/EstamelGG/GGTerm/releases/latest')
    return new Response(
      JSON.stringify({
        tag_name: 'v1.0.12',
        draft: false,
        prerelease: false,
        body: 'Local terminals and update checks.\n中文发布说明。',
        assets: ['.dmg', '.exe', '.AppImage'].map((ext) => ({
          name: `ggterm${ext}`,
          state: 'uploaded'
        }))
      }),
      { headers: { 'content-type': 'application/json' } }
    )
  })
})
app.on('browser-window-created', (_event, win) => {
  win.showInactive = () => {}
  win.webContents.setBackgroundThrottling(false)
  const js = (script) => win.webContents.executeJavaScript(script)
  async function waitFor(script) {
    const end = Date.now() + 12000
    while (Date.now() < end) {
      if (await js(script)) return
      await delay(50)
    }
    throw new Error(`Timeout: ${script}; body: ${await js('document.body.innerText')}`)
  }
  const clickLabel = (label) =>
    js(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`)
  const clickText = (label) =>
    js(
      `[...document.querySelectorAll('button')].find((e) => e.textContent.trim() === ${JSON.stringify(label)}).click()`
    )
  void (async () => {
    await waitFor(`!!document.querySelector('button[aria-label="Local terminal"]')`)
    assert.deepEqual(
      await js(
        `[...document.querySelector('header > div').querySelectorAll('button')].map(e => [e.getAttribute('aria-label'), e.textContent.trim()])`
      ),
      [
        ['Hosts', ''],
        ['Connection graph', ''],
        ['Local terminal', ''],
        ['Browser', '']
      ]
    )
    await js(
      `globalThis.localEvents = []; window.aterm.localTerminal.onEvent(e => localEvents.push(e)); void 0;`
    )
    await clickLabel('Local terminal')
    await waitFor(
      `!!document.querySelector('.xterm-screen canvas') && localEvents.some(e => e.type === 'data')`
    )
    await js(
      `window.aterm.localTerminal.write(localEvents[0].id, ${JSON.stringify(process.platform === 'win32' ? "Write-Output ('VISIBLE_' + (40+2) + '_中文')\r" : 'printf \'VISIBLE_%s_中文\\n\' "$((40+2))"\r')})`
    )
    await waitFor(`localEvents.some(e => e.type === 'data' && e.data.includes('VISIBLE_42_中文'))`)
    await clickLabel('Quick Commands')
    await clickText('New')
    const quickCommand =
      process.platform === 'win32'
        ? "Write-Output ('QUICK_' + (80+2))"
        : 'printf \'QUICK_%s\\n\' "$((80+2))"'
    await js(`
      const nameInput = document.querySelector('input[placeholder="Name, e.g. List containers"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(nameInput, 'Local smoke command');
      nameInput.dispatchEvent(new Event('input', {bubbles:true}));
      const commandInput = nameInput.parentElement.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(commandInput, ${JSON.stringify(quickCommand)});
      commandInput.dispatchEvent(new Event('input', {bubbles:true}));
    `)
    await waitFor(
      `[...document.querySelectorAll('button')].some(e => e.textContent === 'Save' && !e.disabled)`
    )
    await clickText('Save')
    await waitFor(
      `!!document.querySelector('button[aria-label="Send to active terminal"]:not([disabled])')`
    )
    await clickLabel('Send to active terminal')
    await waitFor(`localEvents.some(e => e.type === 'data' && e.data.includes('QUICK_82'))`)
    await clickLabel('Quick Commands')
    await clickLabel('Hosts')
    await clickLabel('Local terminal')
    assert.equal(
      await js(`new Set(localEvents.map(e => e.id)).size`),
      1,
      'switching pages must retain the session'
    )
    // Choose a discovered shell through Settings, then verify persistence and spawning.
    await clickLabel('Settings')
    await waitFor(
      `!!document.querySelector('button[aria-label="Default local shell"]:not([disabled])')`
    )
    const discovered = await js('window.aterm.localTerminal.shells()')
    const chosen = discovered.shells.find((shell) =>
      process.platform === 'win32' ? /cmd\.exe$/i.test(shell.path) : shell.path === '/bin/sh'
    )
    assert.ok(chosen, 'the standard system shell must be discovered')
    await js(
      `document.querySelector('button[aria-label="Default local shell"]').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))`
    )
    await waitFor(`!!document.querySelector('[role="option"]')`)
    await js(
      `[...document.querySelectorAll('[role="option"]')].find(e => e.textContent.includes(${JSON.stringify(chosen.path)})).dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))`
    )
    await waitFor(
      `window.aterm.prefs.get().then(prefs => prefs.localShell === ${JSON.stringify(chosen.path)})`
    )
    await waitFor(
      `document.querySelector('button[aria-label="Default local shell"]').textContent.includes(${JSON.stringify(chosen.path)})`
    )
    const configured = await js('window.aterm.localTerminal.create()')
    assert.equal(configured.shell.toLowerCase(), path.basename(chosen.path).toLowerCase())
    await js(`window.aterm.localTerminal.close(${JSON.stringify(configured.id)})`)
    await delay(150)
    fs.writeFileSync(
      path.join(root, 'local-shell-settings.png'),
      (await win.webContents.capturePage({ stayHidden: true, stayAwake: true })).toPNG()
    )
    await clickLabel('Local terminal')
    assert.equal(
      await js(`getComputedStyle(document.querySelector('.bg-terminal')).borderRadius`),
      '10px'
    )
    await clickLabel('New local terminal')
    await waitFor(`new Set(localEvents.map(e => e.id)).size === 2`)
    await js(`document.querySelectorAll('button[aria-label="Close"]')[1].click()`)
    await waitFor(`!!document.querySelector('[role="dialog"]')`)
    await clickText('Cancel')
    await waitFor(`!document.querySelector('[role="dialog"]')`)
    await delay(200)
    fs.writeFileSync(
      path.join(root, 'local-terminal.png'),
      (await win.webContents.capturePage({ stayHidden: true, stayAwake: true })).toPNG()
    )
    await clickLabel('Settings')
    await clickText('About')
    await clickText('Check for updates')
    await waitFor(
      `[...document.querySelectorAll('[role="status"]')].some(e => e.textContent.includes('1.0.12'))`
    )
    assert.ok(await js(`document.body.textContent.includes('中文发布说明。')`))
    assert.ok(
      await js(
        `[...document.querySelectorAll('button')].some(e => e.textContent === 'Open downloads')`
      )
    )
    fs.writeFileSync(
      path.join(root, 'app-update.png'),
      (await win.webContents.capturePage({ stayHidden: true, stayAwake: true })).toPNG()
    )
    clearTimeout(deadline)
    console.log(`Local terminal UI smoke passed. Screenshots: ${root}`)
    win.destroy()
    app.exit(0)
  })().catch((error) => {
    console.error(error)
    app.exit(1)
  })
})
require('../out/main/index.js')
