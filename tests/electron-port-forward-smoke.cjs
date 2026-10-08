/* Real built renderer + preload + IPC; all saved data stays in an isolated directory. */
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'aterm-forward-smoke-'))
app.setPath('userData', root)
fs.writeFileSync(
  path.join(root, 'preferences.json'),
  JSON.stringify({ locale: 'en', perfMonitorDisabled: true, accentHex: '#37A563' })
)
fs.writeFileSync(
  path.join(root, 'connections.json'),
  JSON.stringify({
    groups: [],
    connections: [
      {
        id: 'forward-test',
        name: 'Production',
        host: '127.0.0.1',
        port: 22,
        username: 'test',
        authType: 'password',
        groupId: null,
        jumpHostIds: [],
        connectTimeout: 1000,
        keepaliveInterval: 5000,
        initCommand: '',
        initDir: '',
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(win, expression) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expression)) return
    await delay(100)
  }
  throw new Error(`Timeout: ${expression}`)
}
app.on('browser-window-created', (_event, win) => {
  win.show = () => {}
  win.webContents.setBackgroundThrottling(false)
  win.webContents.once('did-finish-load', () => {
    void (async () => {
      await waitFor(win, `document.querySelector('button[aria-label="Port forwarding"]')`)
      assert.equal(
        await win.webContents.executeJavaScript(
          `document.querySelector('button[aria-label="Port forwarding"]').getAttribute('aria-pressed')`
        ),
        'false'
      )
      await win.webContents.executeJavaScript(
        `document.querySelector('button[aria-label="Port forwarding"]').click()`
      )
      await waitFor(win, `document.body.textContent.includes('No port forwards yet')`)
      await win.webContents.executeJavaScript(
        `document.querySelector('button[aria-label="New port forward"]').click()`
      )
      await waitFor(win, `document.querySelector('[role="dialog"]')`)
      await win.webContents.executeJavaScript(`
        const input = document.querySelector('[role="dialog"] input[type="text"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Production database');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      `)
      await win.webContents.executeJavaScript(
        `[...document.querySelectorAll('[role="dialog"] button')].find(e => e.textContent.trim() === 'Save').click()`
      )
      await waitFor(
        win,
        `!document.querySelector('[role="dialog"]') && document.body.textContent.includes('Production database')`
      )
      const rules = await win.webContents.executeJavaScript(`window.aterm.portForwards.list()`)
      assert.equal(rules.length, 1)
      assert.equal(rules[0].name, 'Production database')
      assert.equal(rules[0].status, 'stopped')
      assert.equal(rules[0].owner, 'user')
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(root, 'port-forwards.json'), 'utf8')).rules.length,
        1
      )
      await win.webContents.executeJavaScript(
        `window.aterm.portForwards.configure({ name: 'Development preview', hostId: 'forward-test', type: 'remote', listenAddress: '127.0.0.1', listenPort: 8081, targetHost: '127.0.0.1', targetPort: 3000, startPolicy: 'manual' })`
      )
      await waitFor(win, `document.body.textContent.includes('Development preview')`)
      const heights = await win.webContents.executeJavaScript(`(() => {
        const right = [...document.querySelectorAll('[data-slot="activity-panel-header"]')].find(e => e.textContent.includes('Port forwarding'));
        const left = document.querySelector('input[placeholder="Search"]').parentElement.parentElement;
        return { right: right.getBoundingClientRect().height, left: left.getBoundingClientRect().height, rightLine: right.nextElementSibling.getBoundingClientRect().top, leftLine: left.nextElementSibling.getBoundingClientRect().top };
      })()`)
      assert.equal(heights.right, 40)
      assert.equal(heights.left, 40)
      assert(Math.abs(heights.rightLine - heights.leftLine) < 0.1)
      await delay(350)
      await win.webContents.capturePage()
      fs.writeFileSync(path.join(root, 'panel.png'), (await win.webContents.capturePage()).toPNG())
      await win.webContents.executeJavaScript(
        `document.querySelector('button[aria-label="New port forward"]').click()`
      )
      await waitFor(win, `document.querySelector('[role="dialog"]')`)
      await delay(350)
      await win.webContents.capturePage()
      fs.writeFileSync(path.join(root, 'editor.png'), (await win.webContents.capturePage()).toPNG())
      await win.webContents.executeJavaScript(
        `document.querySelector('[role="dialog"] button[data-slot="dialog-shell-close"]').click()`
      )
      await waitFor(win, `!document.querySelector('[role="dialog"]')`)
      await win.webContents.executeJavaScript(`window.aterm.connections.remove('forward-test')`)
      const orphaned = await win.webContents.executeJavaScript(`window.aterm.portForwards.list()`)
      assert.equal(orphaned.length, 2)
      assert(orphaned.every((rule) => rule.status === 'stopped'))
      await waitFor(win, `document.body.textContent.includes('Host deleted')`)
      console.log(
        `PASS: startup collapsed, form save, persisted rules, IPC events, local/remote labels, aligned headers. Screenshots: ${root}`
      )
      app.exit(0)
    })().catch((error) => {
      console.error(error)
      app.exit(1)
    })
  })
})
setTimeout(() => {
  console.error('Port forwarding smoke test timed out')
  app.exit(1)
}, 30000).unref()
require('../out/main/index.js')
