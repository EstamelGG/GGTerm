const assert = require('node:assert/strict')
const path = require('node:path')
const http = require('node:http')
const { app, BrowserWindow } = require('electron')
const esbuild = require('esbuild')
const deadline = setTimeout(() => app.exit(1), 60000)
app
  .whenReady()
  .then(async () => {
    const dir = path.resolve('node_modules/.cache')
    esbuild.buildSync({
      entryPoints: ['src/main/browser.ts'],
      outfile: path.join(dir, 'browser-playwright-smoke.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external'
    })
    esbuild.buildSync({
      entryPoints: ['src/main/browserPlaywrightWorker.ts'],
      outfile: path.join(dir, 'browserPlaywrightWorker.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external'
    })
    const browser = require(path.join(dir, 'browser-playwright-smoke.cjs'))
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(
        req.url === '/frame'
          ? '<label><input type="checkbox">2080ti</label>'
          : '<title>Playwright test</title><button onclick="document.querySelector(\'p\').textContent=\'clicked\'">Go</button><p>ready</p><iframe src="/frame"></iframe>'
      )
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const win = new BrowserWindow({ show: false })
    browser.installBrowser(win)
    try {
      const tab = await browser.openBrowser(`http://127.0.0.1:${server.address().port}`)
      const run = (code) => browser.runBrowserPlaywright(tab.id, code, 3000)
      console.log('Playwright smoke: connecting')
      const result = await run(
        "await page.getByRole('button', {name:'Go'}).click(); return await page.locator('p').innerText()"
      )
      assert.equal(result.result, 'clicked')
      const checked = await run(
        "const box=page.frameLocator('iframe').getByRole('checkbox');await box.check();await box.check();return await box.isChecked()"
      )
      assert.equal(checked.result, true)
      assert.equal(
        (await run('return await page.evaluate(() => document.title)')).result,
        'Playwright test'
      )
      await assert.rejects(run('while(true) {}'), /timed out/)
      assert.equal((await run('return page.url()')).result, tab.url)
      const dialog = await run(
        "await page.evaluate(() => { document.querySelector('p').textContent=confirm('Continue?') ? 'accepted' : 'dismissed' })"
      )
      assert.equal(dialog.dialog.type, 'confirm')
      await browser.handleBrowserDialog(tab.id, true)
      assert.equal((await run("return await page.locator('p').innerText()")).result, 'accepted')
      const controller = new AbortController()
      const pending = browser.runBrowserPlaywright(
        tab.id,
        'await page.waitForTimeout(30000)',
        3000,
        controller.signal
      )
      setTimeout(() => controller.abort(), 500)
      await assert.rejects(pending, /cancelled/)
      console.log(
        'Playwright smoke passed: hidden page trusted click, iframe check, evaluate, worker timeout and recovery'
      )
    } finally {
      win.destroy()
      server.close()
      clearTimeout(deadline)
    }
    app.exit(0)
  })
  .catch((e) => {
    console.error(e)
    app.exit(1)
  })
