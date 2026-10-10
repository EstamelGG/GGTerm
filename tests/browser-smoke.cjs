const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const { app, BrowserWindow, webContents } = require('electron')
const deadline = setTimeout(() => app.exit(1), 30000)
app
  .whenReady()
  .then(async () => {
    const bundle = path.resolve('node_modules/.cache/browser-smoke.cjs')
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
    console.log('Browser smoke: Electron ready')
    const browser = require(bundle)
    const server = http.createServer((req, res) => {
      if (req.url === '/failed') {
        req.socket.destroy()
        return
      }
      res.setHeader('Content-Type', 'text/html')
      if (req.url === '/interact') {
        res.end(`<title>Interaction</title><body>
          <label for="name">Name</label><input id="name" value="old"><textarea id="notes"></textarea>
          <input id="password" type="password" value="secret"><input id="locked" readonly value="locked">
          <button id="save">Save</button><button disabled id="disabled">Disabled</button>
          <button class="duplicate">One</button><button class="duplicate">Two</button>
          <select id="choice"><option value="a">A</option><option value="b">B</option></select>
          <input id="check" type="checkbox"><div id="editable" contenteditable="true">old editable</div>
          <div id="shadow"></div><div id="status"></div><div style="height:2000px"></div>
          <script>
          nameInput=document.getElementById('name');
          nameInput.addEventListener('input', e => document.getElementById('status').textContent='typed:'+nameInput.value+':'+e.isTrusted);
          nameInput.addEventListener('keydown', e => {if(e.key==='Enter') document.getElementById('status').textContent='Enter:'+e.isTrusted;});
          document.getElementById('save').onmouseover=()=>document.getElementById('status').textContent='hovered';
          document.getElementById('save').onclick=e=>{document.getElementById('status').textContent='saved:'+nameInput.value+':'+e.isTrusted;};
          document.getElementById('choice').onchange=e=>document.getElementById('status').textContent='choice:'+e.target.value;
          document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow button</button>';
          document.querySelector('#shadow').shadowRoot.querySelector('button').onclick=()=>document.getElementById('status').textContent='shadow clicked';
          </script></body>`)
        return
      }
      res.end(
        `<title>${req.url === '/next' ? 'Next' : 'Test page'}</title><body><h1>Readable content</h1><a href="/next">Next page</a><script>document.body.append(' Dynamic text'); document.body.append(' Node: '+typeof require)</script></body>`
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const win = new BrowserWindow({ show: false })
    browser.installBrowser(win)
    const url = `http://127.0.0.1:${server.address().port}`
    try {
      const blank = await browser.openBrowser('about:blank')
      const anotherBlank = await browser.openBrowser('about:blank')
      assert.notEqual(blank.id, anotherBlank.id)
      assert.equal(blank.url, 'about:blank')
      assert.equal(browser.browserState().tabs.length, 2)
      await browser.navigateBrowser(blank.id, url)
      assert.equal(browser.browserState().tabs.find((tab) => tab.id === blank.id).url, url + '/')
      browser.closeBrowser(blank.id)
      assert.equal(browser.browserState().tabs[0].id, anotherBlank.id)
      browser.closeBrowser(anotherBlank.id)
      console.log('Browser smoke: opening page')
      const first = await browser.openBrowser(url)
      assert.equal(browser.browserState().foregroundId, null)
      assert.equal(win.isVisible(), false)
      console.log('Browser smoke: reading page')
      const read = await browser.readBrowser(first.id, 0, 20)
      assert.equal(read.content.length, 20)
      assert.match(read.content, /^Readable content/)
      assert.ok(read.nextOffset)
      assert.equal(read.links[0].url, `${url}/next`)
      const rest = await browser.readBrowser(first.id, 20)
      assert.match(rest.content, /Dynamic text/)
      assert.match(rest.content, /Node: undefined/)
      const snapshot = await browser.captureBrowser(first.id)
      assert.equal(snapshot.kind, 'page')
      assert.match(snapshot.content, /Dynamic text/)
      const pageContents = webContents.getAllWebContents().find((wc) => wc.getURL() === url + '/')
      const selection = browser.pickBrowserElement(first.id, '#3388ff')
      await pageContents.executeJavaScriptInIsolatedWorld(999, [
        { code: 'Boolean(globalThis.__atPickerCancel)' }
      ])
      await pageContents.executeJavaScript(
        "document.querySelector('a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))"
      )
      const element = await selection
      assert.equal(element.kind, 'element')
      assert.equal(element.element.tagName, 'a')
      assert.equal(element.element.text, 'Next page')
      assert.match(element.element.html, /href="\/next"/)
      assert.equal(pageContents.getURL(), url + '/')
      const cancellation = browser.pickBrowserElement(first.id, '#3388ff')
      await pageContents.executeJavaScriptInIsolatedWorld(999, [
        { code: 'Boolean(globalThis.__atPickerCancel)' }
      ])
      await browser.cancelBrowserPicker(first.id)
      assert.equal(await cancellation, null)
      const escape = browser.pickBrowserElement(first.id, '#3388ff')
      await pageContents.executeJavaScriptInIsolatedWorld(999, [
        { code: 'Boolean(globalThis.__atPickerCancel)' }
      ])
      await pageContents.executeJavaScript(
        "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
      )
      assert.equal(await escape, null)
      await browser.navigateBrowser(first.id, `${url}/next`)
      assert.equal(browser.browserState().tabs[0].title, 'Next')
      assert.equal(browser.browserState().tabs[0].canGoBack, true)
      const interactive = await browser.openBrowser(`${url}/interact`)
      const act = (action, extra = {}) =>
        browser.interactBrowser(interactive.id, { action, ...extra })
      let observed = await act('snapshot')
      assert.equal(observed.elements.find((el) => el.name === 'Name').tag, 'input')
      assert.equal(observed.elements.find((el) => el.type === 'password').value, '[redacted]')
      const oldRef = observed.elements.find((el) => el.name === 'Save').ref
      const inputRef = observed.elements.find((el) => el.name === 'Name').ref
      observed = await act('fill', { ref: inputRef, text: '你好 Browser' })
      assert.match(observed.content, /typed:你好 Browser:true/)
      assert.equal(observed.elements.find((el) => el.name === 'Name').value, '你好 Browser')
      await assert.rejects(act('click', { ref: oldRef }), /stale/)
      observed = await act('type', { selector: '#name', text: '!' })
      assert.match(observed.content, /typed:你好 Browser!:true/)
      observed = await act('click', { selector: '#save' })
      assert.match(observed.content, /saved:你好 Browser!:false/)
      observed = await act('press', { selector: '#name', key: 'Enter' })
      assert.match(observed.content, /Enter:true/)
      observed = await act('select', { selector: '#choice', value: 'b' })
      assert.match(observed.content, /choice:b/)
      observed = await act('click', { selector: '#check' })
      assert.equal(observed.elements.find((el) => el.type === 'checkbox').checked, true)
      observed = await act('fill', { selector: '#editable', text: 'Edited content' })
      assert.match(observed.content, /Edited content/)
      observed = await act('fill', { selector: '#name', text: '' })
      assert.equal(observed.elements.find((el) => el.name === 'Name').value, '')
      await assert.rejects(act('click', { selector: '.duplicate' }), /exactly one/)
      await assert.rejects(act('click', { selector: '#disabled' }), /disabled/)
      await assert.rejects(act('fill', { selector: '#locked', text: 'x' }), /read-only/)
      observed = await act('snapshot')
      const shadowRef = observed.elements.find((el) => el.name === 'Shadow button').ref
      observed = await act('click', { ref: shadowRef })
      assert.match(observed.content, /shadow clicked/)
      observed = await act('hover', { selector: '#save' })
      assert.match(observed.content, /hovered/)
      await act('scroll', { deltaY: 400 })
      await act('wait', { selector: '#save', timeoutMs: 500 })
      await assert.rejects(act('wait', { selector: '#missing', timeoutMs: 100 }), /Timed out/)
      const signal = new AbortController()
      signal.abort()
      await assert.rejects(
        browser.interactBrowser(interactive.id, { action: 'snapshot' }, signal.signal),
        /abort/i
      )
      assert.equal(browser.browserState().foregroundId, null)
      assert.equal(win.isVisible(), false)
      browser.showBrowser(interactive.id)
      const interactiveView = win.contentView.children.find((view) =>
        view.webContents?.getURL().endsWith('/interact')
      )
      interactiveView.setBounds({ x: 0, y: 0, width: 1000, height: 700 })
      interactiveView.setVisible(true)
      await new Promise((resolve) => setTimeout(resolve, 100))
      observed = await act('fill', { selector: '#name', text: 'Foreground' })
      observed = await act('click', { selector: '#save' })
      assert.match(observed.content, /saved:Foreground:true/)
      await act('click', { selector: '#check' })
      await act('fill', { selector: '#notes', text: '多行\n内容' })
      observed = await act('snapshot')
      assert.equal(observed.elements.find((el) => el.tag === 'textarea').value, '多行\n内容')
      // Native views must disappear before renderer-owned loading/error states are shown.
      const navigationStarted = new Promise((resolve) =>
        interactiveView.webContents.once('did-start-loading', resolve)
      )
      const failedNavigation = browser.navigateBrowser(interactive.id, url + '/failed')
      const rejectedNavigation = assert.rejects(failedNavigation)
      await navigationStarted
      assert.equal(interactiveView.getVisible(), false)
      await rejectedNavigation
      assert.equal(interactiveView.getVisible(), false)
      const failedTab = browser.browserState().tabs.find((tab) => tab.id === interactive.id)
      assert.ok(failedTab.error)
      assert.equal(failedTab.url, url + '/failed')
      await browser.navigateBrowser(interactive.id, url + '/interact')
      assert.equal(
        browser.browserState().tabs.find((tab) => tab.id === interactive.id).error,
        undefined
      )
      browser.closeBrowser(interactive.id)
      browser.showBrowser(first.id)
      assert.equal(browser.browserState().foregroundId, first.id)
      assert.equal(win.isVisible(), true)
      const second = await browser.openBrowser(url)
      assert.equal(browser.browserState().foregroundId, first.id)
      await assert.rejects(browser.openBrowser('file:///etc/passwd'), /HTTP/)
      await assert.rejects(browser.navigateBrowser(first.id, 'javascript:alert(1)'), /HTTP/)
      const secondContents = webContents.getAllWebContents().find((wc) => wc.getURL() === url + '/')
      const destroyed = new Promise((resolve) => secondContents.once('destroyed', resolve))
      browser.closeBrowser(second.id)
      await destroyed
      assert.equal(secondContents.isDestroyed(), true)
      browser.closeBrowser(first.id)
      assert.equal(browser.browserState().tabs.length, 0)
      console.log(
        'Browser smoke passed: background/foreground, rendered text, pagination, links, navigation, DOM attachments, click handlers, trusted input/keys, select, shadow DOM, stale refs, cancellation, sandbox, cleanup'
      )
    } finally {
      win.destroy()
      server.close()
      clearTimeout(deadline)
    }
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    clearTimeout(deadline)
    app.exit(1)
  })
