const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const https = require('node:https')
const { spawnSync } = require('node:child_process')
const { app, BrowserWindow, webContents } = require('electron')
const deadline = setTimeout(() => {
  console.error('TLS smoke timed out')
  app.exit(1)
}, 45000)
app
  .whenReady()
  .then(async () => {
    const bundle = path.resolve('node_modules/.cache/browser-tls-smoke.cjs')
    fs.mkdirSync(path.dirname(bundle), { recursive: true })
    require('esbuild').buildSync({
      entryPoints: ['src/main/browser.ts'],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      logLevel: 'silent'
    })
    const browser = require(bundle)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aterm-browser-tls-'))
    const certificate = (name) => {
      const key = path.join(dir, `${name}.key`),
        cert = path.join(dir, `${name}.pem`)
      const result = spawnSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          cert,
          '-days',
          '1',
          '-subj',
          `/CN=${name}`
        ],
        { encoding: 'utf8' }
      )
      if (result.status !== 0) throw new Error(result.stderr)
      return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
    }
    const firstCert = certificate('self-signed'),
      secondCert = certificate('changed-cert')
    const servers = new Set()
    const start = async (cert, port = 0) => {
      const server = https.createServer(cert, (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end('<title>TLS page</title><h1>Trusted by user</h1>')
      })
      server.on('tlsClientError', () => {})
      servers.add(server)
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', resolve)
      })
      return server
    }
    let win = new BrowserWindow({ show: false })
    browser.installBrowser(win)
    try {
      const a = await start(firstCert),
        b = await start(firstCert)
      const origin = `https://127.0.0.1:${a.address().port}`
      const otherOrigin = `https://127.0.0.1:${b.address().port}`
      let tab = await browser.openBrowser(origin)
      assert.equal(tab.url, origin + '/')
      assert.ok(tab.certificateError)
      assert.equal(tab.certificateError.origin, origin)
      assert.match(tab.certificateError.fingerprint, /^([\dA-F]{2}:){31}[\dA-F]{2}$/)
      assert.ok(tab.certificateError.validTo > tab.certificateError.validFrom)
      await assert.rejects(browser.readBrowser(tab.id), /TLS certificate/)
      await assert.rejects(browser.interactBrowser(tab.id, { action: 'snapshot' }), /manually/)
      await assert.rejects(browser.approveBrowserCertificate(tab.id, 'stale-request'), /changed/)
      console.log('TLS smoke: certificate blocked and details available')
      await browser.approveBrowserCertificate(tab.id, tab.certificateError.requestId)
      tab = browser.browserState().tabs.find((t) => t.id === tab.id)
      assert.equal(tab.certificateError, undefined)
      assert.equal(tab.certificateTrust.origin, origin)
      assert.match((await browser.readBrowser(tab.id)).content, /Trusted by user/)
      await browser.navigateBrowser(tab.id, origin + '/another')
      assert.match((await browser.readBrowser(tab.id)).content, /Trusted by user/)
      console.log('TLS smoke: exact certificate approval and reload succeeded')
      const other = await browser.openBrowser(otherOrigin)
      assert.ok(other.certificateError, 'same certificate on another port must remain blocked')
      const outsider = new BrowserWindow({ show: false })
      await assert.rejects(outsider.loadURL(origin), /CERT/)
      outsider.destroy()
      const port = a.address().port
      const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === origin + '/another')
      await wc.session.closeAllConnections()
      await new Promise((resolve) => a.close(resolve))
      servers.delete(a)
      await start(secondCert, port)
      await assert.rejects(browser.navigateBrowser(tab.id, origin + '/changed'), /CERT/)
      const changed = browser.browserState().tabs.find((t) => t.id === tab.id)
      assert.ok(changed.certificateError, 'changed leaf certificate must require new user approval')
      assert.notEqual(changed.certificateError.fingerprint, tab.certificateTrust.fingerprint)
      const oldWindow = win
      win = new BrowserWindow({ show: false })
      browser.installBrowser(win)
      oldWindow.destroy()
      console.log('TLS smoke: checking a fresh window')
      const fresh = await browser.openBrowser(otherOrigin)
      assert.ok(fresh.certificateError, 'new app window must not inherit approvals')
      console.log(
        'TLS smoke passed: blocked by default, manual approval, exact origin/port/certificate scope, other windows isolated, certificate rotation, no persisted trust'
      )
    } finally {
      win.destroy()
      for (const server of servers) {
        server.closeAllConnections()
        server.close()
      }
      fs.rmSync(dir, { recursive: true, force: true })
      clearTimeout(deadline)
    }
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    clearTimeout(deadline)
    app.exit(1)
  })
