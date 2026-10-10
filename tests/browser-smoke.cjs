const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const { app, BrowserWindow, webContents, Menu } = require('electron')
const deadline = setTimeout(() => app.exit(1), 60000)
app
  .whenReady()
  .then(async () => {
    const bundle = path.resolve('node_modules/.cache/browser-smoke.cjs')
    fs.mkdirSync(path.dirname(bundle), { recursive: true })
    require('esbuild').buildSync({
      stdin: {
        contents:
          "export * from './src/main/browser'; export { evaluateBrowserScript } from './src/main/browserAutomation'; export {browserHumanInputs} from './src/main/ai/browserHumanInput';",
        resolveDir: process.cwd(),
        loader: 'ts'
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      logLevel: 'silent'
    })
    require('esbuild').buildSync({
      entryPoints: ['src/main/browserPlaywrightWorker.ts'],
      outfile: path.resolve('node_modules/.cache/browserPlaywrightWorker.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external'
    })
    console.log('Browser smoke: Electron ready')
    const browser = require(bundle)
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/frames')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        if (req.url === '/frames') {
          res.end(`<h1>Outer menu</h1><button id="duplicate">Outer</button>
            <iframe id="assets" style="width:90%;height:500px;border:6px solid" src="/frames/child"></iframe>
            <iframe style="display:none" src="/frames/hidden"></iframe>
            <iframe src="http://localhost:${server.address().port}/frames/cross"></iframe>`)
        } else if (req.url === '/frames/child') {
          res.end(`<h1>共 34 条数据</h1><input id="frame-input" aria-label="Frame input"><button id="duplicate">Frame button</button>
            <table>${Array.from({ length: 10 }, (_, i) => '<tr><td>server-' + i + '</td><td><button class="row-action" onclick="document.querySelector(\'#frame-status\').textContent=\'selected server-' + i + '\'">连接</button></td></tr>').join('')}</table>
            <select id="frame-select"><option value="a">A</option><option value="b">B</option></select><div id="frame-status"></div>
            <iframe style="width:400px;height:200px;border:4px solid" src="/frames/nested"></iframe>
            <script>document.querySelector('button').onclick=e=>document.querySelector('#frame-status').textContent='frame click:'+e.isTrusted;
            document.querySelector('input').oninput=e=>document.querySelector('#frame-status').textContent='frame input:'+e.target.value+':'+e.isTrusted;
            document.querySelector('select').onchange=e=>document.querySelector('#frame-status').textContent='selected:'+e.target.value;</script>`)
        } else if (req.url === '/frames/nested') {
          res.end(
            `<button id="nested-button">Nested button</button><div id="nested-status"></div><script>document.querySelector('button').onclick=e=>document.querySelector('#nested-status').textContent='nested click:'+e.isTrusted;</script>`
          )
        } else res.end('<p>Hidden or cross-origin content must not be read</p>')
        return
      }
      if (req.url === '/slow-resource') {
        setTimeout(() => res.end('slow image'), 3000)
        return
      }
      if (req.url === '/slow-page') {
        res.setHeader('Content-Type', 'text/html')
        res.end('<title>Progressive page</title><h1>Body is usable</h1><img src="/slow-resource">')
        return
      }
      if (req.url === '/failed') {
        req.socket.destroy()
        return
      }
      res.setHeader('Content-Type', 'text/html')
      if (req.url === '/interact') {
        res.end(`<title>Interaction</title><body>
          <p id="selection">Selectable browser text for copying.</p><label for="name">Name</label><input id="name" value="old"><textarea id="notes"></textarea>
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
    await win.loadURL('about:blank')
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
      const started = Date.now()
      const progressive = await browser.openBrowser(url + '/slow-page')
      assert(Date.now() - started < 2000, 'opening must not wait for the slow image')
      assert.equal(progressive.ready, true)
      assert.equal(progressive.loading, true)
      const earlyRead = await browser.readBrowser(progressive.id)
      assert.match(earlyRead.content, /Body is usable/)
      const earlySnapshot = await browser.interactBrowser(progressive.id, { action: 'snapshot' })
      assert.match(earlySnapshot.content, /Body is usable/)
      assert(Date.now() - started < 2000, 'reading must not wait for the slow image')
      browser.closeBrowser(progressive.id)
      const framed = await browser.openBrowser(url + '/frames')
      const frameAct = (action, extra = {}) =>
        browser.interactBrowser(framed.id, { action, ...extra })
      const initialFrameRead = await browser.readBrowser(framed.id)
      assert(
        initialFrameRead.frames.some((f) => f.frame === 'main/0' && f.visible),
        'background read gives responsive iframe a viewport'
      )
      await frameAct('wait', { selector: '#nested-button', timeoutMs: 5000 })
      const frameRead = await browser.readBrowser(framed.id)
      assert.match(frameRead.content, /共 34 条数据/)
      assert(!frameRead.content.includes('Hidden or cross-origin content'))
      let frameMetadata = frameRead.frames
      const frameDeadline = Date.now() + 3000
      while (
        !frameMetadata.some((f) => !f.accessible && f.url.includes('localhost')) &&
        Date.now() < frameDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        frameMetadata = (await browser.readBrowser(framed.id)).frames
      }
      assert(frameMetadata.some((f) => !f.accessible && f.url.includes('localhost')))
      let frameSnapshot = await frameAct('snapshot')
      const frameInput = frameSnapshot.elements.find((el) => el.name === 'Frame input')
      assert.equal(frameInput.frame, 'main/0')
      frameSnapshot = await frameAct('fill', { ref: frameInput.ref, text: 'iframe typing' })
      assert.match(frameSnapshot.content, /frame input:iframe typing:true/)
      await assert.rejects(frameAct('click', { selector: '.row-action' }), /matched 10.*server-7/)
      const candidates = await frameAct('snapshot', {
        selector: '.row-action',
        frame: 'main/0',
        offset: 5,
        limit: 3
      })
      assert.equal(candidates.total, 10)
      assert.equal(candidates.nextOffset, 8)
      assert.equal(candidates.elements.length, 3)
      const desired = candidates.elements.find((el) => el.context.includes('server-7'))
      assert.equal(desired.name, '连接')
      frameSnapshot = await frameAct('click', { ref: desired.ref })
      assert.match(frameSnapshot.content, /selected server-7/)
      await assert.rejects(frameAct('click', { selector: '#duplicate' }), /exactly one/)
      frameSnapshot = await frameAct('click', { selector: '#duplicate', frame: 'main/0' })
      assert.match(frameSnapshot.content, /frame click:true/)
      frameSnapshot = await frameAct('select', { selector: '#frame-select', value: 'b' })
      assert.match(frameSnapshot.content, /selected:b/)
      await assert.rejects(
        frameAct('wait', { selector: '.el-table', timeoutMs: 100 }),
        /frames.*matched.*0/
      )
      const framedView = win.contentView.children.find(
        (v) => v.webContents?.getURL() === url + '/frames'
      )
      framedView.setBounds({ x: 20, y: 20, width: 1000, height: 700 })
      win.show()
      framedView.setVisible(true)
      frameSnapshot = await frameAct('click', { selector: '#duplicate', frame: 'main/0' })
      assert.match(frameSnapshot.content, /frame click:true/)
      frameSnapshot = await frameAct('click', { selector: '#nested-button' })
      assert.match(frameSnapshot.content, /nested click:true/)
      const overlapWc = framedView.webContents
      await browser.evaluateBrowserScript(
        overlapWc,
        `(() => {
        const cover=document.createElement('div');cover.id='test-cover';cover.style='position:fixed;inset:0;background:#8888;z-index:2147483647';document.body.append(cover);
        const doc=document.querySelector('#assets').contentDocument;
        const input=doc.querySelector('#frame-input');input.readOnly=true;
        const button=doc.querySelector('#duplicate');button.disabled=true;
        button.onmouseover=()=>doc.querySelector('#frame-status').textContent='disabled hover';
      })()`
      )
      await assert.rejects(
        frameAct('click', { selector: '.row-action', mode: 'mouse' }),
        /matched 10/
      )
      await assert.rejects(
        frameAct('click', { selector: '#nested-button', mode: 'mouse', timeoutMs: 200 }),
        /intercepts pointer events|Timeout/
      )
      frameSnapshot = await frameAct('click', { selector: '#nested-button', mode: 'dom' })
      assert.match(frameSnapshot.content, /nested click:false/)
      await frameAct('hover', { selector: '#duplicate', frame: 'main/0', mode: 'dom' })
      assert.match((await frameAct('snapshot')).content, /disabled hover/)
      await assert.rejects(
        frameAct('click', { selector: '#duplicate', frame: 'main/0', mode: 'dom' }),
        /disabled/
      )
      await frameAct('press', { selector: '#frame-input', key: 'Tab' })
      await assert.rejects(
        frameAct('fill', { selector: '#frame-input', text: 'forbidden', timeoutMs: 200 }),
        /read-only|editable/
      )
      framedView.setVisible(false)
      frameSnapshot = await frameAct('click', { selector: '#nested-button', mode: 'dom' })
      assert.equal(frameSnapshot.snapshot, 'unchanged')
      assert.match((await frameAct('snapshot')).content, /nested click:false/)
      await frameAct('hover', { selector: '#duplicate', frame: 'main/0', mode: 'dom' })
      await assert.rejects(
        frameAct('click', { selector: '#nested-button', mode: 'mouse', timeoutMs: 200 }),
        /intercepts pointer events|Timeout/
      )
      await browser.evaluateBrowserScript(
        overlapWc,
        `document.querySelector('#test-cover').remove();document.querySelector('#assets').contentDocument.querySelector('#frame-input').readOnly=false`
      )
      framedView.setVisible(true)
      const inputPending = new Promise((resolve) =>
        browser.browserHumanInputs.once('request', resolve)
      )
      const secretCall = browser.requestBrowserInput(
        framed.id,
        { action: 'fill', selector: '#frame-input' },
        'test-session',
        '请输入验证码'
      )
      const request = await inputPending
      await assert.rejects(
        browser.browserHumanInputs.submit('wrong-session', request.executionId, 'never-used'),
        /conversation/
      )
      await browser.browserHumanInputs.submit(
        'test-session',
        request.executionId,
        'unique-secret-7359'
      )
      assert.deepEqual(await secretCall, { humanInputOutcome: 'submitted' })
      frameSnapshot = await frameAct('snapshot')
      assert.equal(
        frameSnapshot.elements.find((el) => el.name === 'Frame input').value,
        '[redacted]'
      )
      assert.ok(!JSON.stringify(frameSnapshot).includes('unique-secret-7359'))
      const secretRead = await browser.runBrowserPlaywright(
        framed.id,
        "return await page.frameLocator('#assets').locator('#frame-input').inputValue()"
      )
      assert.equal(secretRead.result, '[redacted]')
      assert.ok(
        !JSON.stringify(await browser.readBrowser(framed.id)).includes('unique-secret-7359')
      )
      await assert.rejects(
        frameAct('fill', { selector: '#frame-input', text: 'forbidden', timeoutMs: 200 }),
        /request_input/
      )
      const secondPending = new Promise((resolve) =>
        browser.browserHumanInputs.once('request', resolve)
      )
      const expiredCall = browser.requestBrowserInput(
        framed.id,
        { action: 'fill', selector: '#frame-input' },
        'test-session',
        '请输入验证码'
      )
      const secondRequest = await secondPending
      // Frame navigation makes old DOM refs invalid even while the old document still exists.
      const oldFrameRef = frameSnapshot.elements.find((el) => el.name === 'Frame input').ref
      const frameWc = framedView.webContents
      await browser.evaluateBrowserScript(
        frameWc,
        `document.querySelector('#assets').src='/frames/hidden'`
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.deepEqual(await expiredCall, { humanInputOutcome: 'cancelled' })
      await assert.rejects(
        browser.browserHumanInputs.submit('test-session', secondRequest.executionId, 'never-used'),
        /not found/
      )
      await assert.rejects(frameAct('fill', { ref: oldFrameRef, text: 'stale' }), /stale/)
      browser.closeBrowser(framed.id)
      win.hide()
      console.log(
        'Browser smoke: same-origin frames, nested trusted clicks, input, diagnostics and stale refs passed'
      )
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
      while (
        !(await browser.evaluateBrowserScript(
          pageContents,
          'Boolean(globalThis.__atPickerCancel)',
          999
        ))
      )
        await new Promise((resolve) => setTimeout(resolve, 10))
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
      while (
        !(await browser.evaluateBrowserScript(
          pageContents,
          'Boolean(globalThis.__atPickerCancel)',
          999
        ))
      )
        await new Promise((resolve) => setTimeout(resolve, 10))
      await browser.cancelBrowserPicker(first.id)
      assert.equal(await cancellation, null)
      const escape = browser.pickBrowserElement(first.id, '#3388ff')
      while (
        !(await browser.evaluateBrowserScript(
          pageContents,
          'Boolean(globalThis.__atPickerCancel)',
          999
        ))
      )
        await new Promise((resolve) => setTimeout(resolve, 10))
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
      assert.equal(observed.snapshot, 'delta')
      const unchanged = await act('wait', { selector: '#name' })
      assert.equal(unchanged.snapshot, 'unchanged')
      assert.equal(unchanged.content, undefined)
      assert.equal(unchanged.elements.length, 0)
      const otherSession = await act('wait', { selector: '#name', observationKey: 'other-agent' })
      assert.equal(otherSession.snapshot, 'full')
      const sameSession = await act('wait', { selector: '#name' })
      assert.equal(sameSession.snapshot, 'unchanged')
      // An unchanged element keeps its ref across multiple actions and scoped reads.
      await act('snapshot', { selector: '#name' })
      observed = await act('type', { selector: '#name', text: '!' })
      assert.match(observed.content, /typed:你好 Browser!:true/)
      observed = await act('click', { ref: oldRef })
      assert.match(observed.content, /saved:你好 Browser!:true/)
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
      await assert.rejects(act('click', { selector: '#disabled', timeoutMs: 200 }), /disabled/)
      await assert.rejects(
        act('fill', { selector: '#locked', text: 'x', timeoutMs: 200 }),
        /read-only|editable/
      )
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
      const selectionPoint = await interactiveView.webContents.executeJavaScript(`(() => {
        const rect = document.querySelector('#selection').getBoundingClientRect();
        return {x: Math.round(rect.x + 20), y: Math.round(rect.y + rect.height / 2)};
      })()`)
      interactiveView.webContents.sendInputEvent({
        type: 'mouseDown',
        button: 'left',
        clickCount: 2,
        ...selectionPoint
      })
      interactiveView.webContents.sendInputEvent({
        type: 'mouseUp',
        button: 'left',
        clickCount: 2,
        ...selectionPoint
      })
      const selectedText = await interactiveView.webContents.executeJavaScript(
        'getSelection().toString()'
      )
      assert.match(selectedText, /Selectable/)
      const originalBuildMenu = Menu.buildFromTemplate
      let contextItems
      Menu.buildFromTemplate = (items) => {
        contextItems = items
        return {
          popup() {
            /* Avoid opening a native menu during this assertion. */
          }
        }
      }
      try {
        interactiveView.webContents.emit(
          'context-menu',
          {},
          {
            selectionText: selectedText,
            isEditable: false,
            linkURL: '',
            editFlags: { canCopy: true }
          }
        )
        assert.equal(contextItems.find((item) => item.role === 'copy').enabled, true)
        assert.ok(contextItems.find((item) => item.role === 'selectAll'))
      } finally {
        Menu.buildFromTemplate = originalBuildMenu
      }
      await browser.withBrowserControl(interactive.id, async () => {
        const overlay = win.contentView.children.find((view) =>
          view.webContents?.getURL().startsWith('data:text/html')
        )
        assert.equal(
          browser.browserState().tabs.find((tab) => tab.id === interactive.id).controlling,
          true
        )
        assert.equal(overlay.getVisible(), true)
        assert.equal(interactiveView.getVisible(), true)
        assert.deepEqual(overlay.getBounds(), interactiveView.getBounds())
        await act('fill', { selector: '#name', text: 'Controlled' })
        const result = await act('click', { selector: '#save' })
        assert.match(result.content, /saved:Controlled:true/)
      })
      assert.equal(
        browser.browserState().tabs.find((tab) => tab.id === interactive.id).controlling,
        false
      )
      const overlay = win.contentView.children.find((view) =>
        view.webContents?.getURL().startsWith('data:text/html')
      )
      assert.equal(overlay.getVisible(), false)
      await assert.rejects(
        browser.withBrowserControl(interactive.id, async () => {
          throw new Error('control failed')
        }),
        /control failed/
      )
      assert.equal(overlay.getVisible(), false)
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
