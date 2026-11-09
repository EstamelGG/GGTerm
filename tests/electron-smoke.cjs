/* Runs the real built application with isolated test data and hidden windows. */
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const iconv = require('iconv-lite')
let fixture
let launchedAt = 0

const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'aterm-smoke-'))
app.setPath('userData', root)
fs.writeFileSync(
  path.join(root, 'preferences.json'),
  JSON.stringify({
    locale: 'en',
    confirmCloseSession: false,
    perfMonitorDisabled: true,
    accentHex: '#37A563'
  })
)
fs.writeFileSync(
  path.join(root, 'connections.json'),
  JSON.stringify({
    groups: [],
    connections: [
      {
        id: 'manual-test',
        name: 'Manual test',
        host: '127.0.0.1',
        port: 1,
        username: 'test',
        authType: 'manual',
        groupId: null,
        connectTimeout: 1000,
        keepaliveInterval: 5000,
        initCommand: '',
        initDir: '',
        perfDisabled: true,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
)

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(win, expression, timeout = 12000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expression)) return
    await delay(100)
  }
  console.error(await win.webContents.executeJavaScript(`document.body.innerText`))
  console.error(
    await win.webContents.executeJavaScript(
      `({hasFocus:document.hasFocus(),active:document.activeElement.outerHTML.slice(0,1200), textareas:[...document.querySelectorAll('.monaco-editor .native-edit-context')].map(e=>e.outerHTML.slice(0,500))})`
    )
  )
  throw new Error(`Timeout: ${expression}`)
}

app.on('browser-window-created', (_event, win) => {
  const editorLifetimeErrors = []
  win.webContents.on('console-message', (event) => {
    if (/Trying to add a disposable to a DisposableStore/.test(event.message))
      editorLifetimeErrors.push(event.message)
  })
  const executeJavaScript = win.webContents.executeJavaScript.bind(win.webContents)
  win.webContents.executeJavaScript = async (source, ...args) => {
    try {
      return await executeJavaScript(source, ...args)
    } catch (error) {
      console.error('Failed renderer step:', source)
      throw error
    }
  }
  const { ipcMain } = require('electron')
  ipcMain.removeHandler('ai:listSessions')
  ipcMain.handle('ai:listSessions', () => [
    { id: 'ui-test', title: 'Viewer one', createdAt: 1, updatedAt: 1 },
    { id: 'other-test', title: 'Viewer two', createdAt: 1, updatedAt: 1 }
  ])
  ipcMain.removeHandler('ai:getMessages')
  ipcMain.handle('ai:getMessages', () => [])
  win.show = () => {}
  win.webContents.setBackgroundThrottling(false)
  const run = async () => {
    const dialogCache = path.resolve('node_modules/.cache/dialogs')
    fs.mkdirSync(dialogCache, { recursive: true })
    const inspectDialog = async (name) => {
      await waitFor(win, `document.querySelector('[data-slot="dialog-shell"]')`)
      await delay(220)
      const layout = await win.webContents.executeJavaScript(`(() => {
        const dialog = [...document.querySelectorAll('[data-slot="dialog-shell"]')].at(-1);
        const r = dialog.getBoundingClientRect();
        const footer = dialog.querySelector('[data-slot="dialog-shell-footer"]');
        return { fits: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1,
          scrollWidth: dialog.scrollWidth, width: dialog.clientWidth,
          actionsFit: !footer || [...footer.querySelectorAll('button')].every(button => {
            const b = button.getBoundingClientRect();
            return b.left >= r.left && b.right <= r.right + 1 && b.top >= r.top && b.bottom <= r.bottom + 1;
          }) };
      })()`)
      assert(
        layout.fits && layout.actionsFit && layout.scrollWidth <= layout.width + 1,
        `${name}: ${JSON.stringify(layout)}`
      )
      fs.writeFileSync(
        path.join(dialogCache, `${name}.png`),
        (await win.webContents.capturePage({ stayHidden: true, stayAwake: true })).toPNG()
      )
    }
    await waitFor(win, `document.body.textContent.includes('Manual test')`)
    const startupMs = Date.now() - launchedAt
    const toolbarWidth = await win.webContents.executeJavaScript(
      `document.querySelector('input[aria-label="Search"]').closest('[data-slot="chrome-row"]').getBoundingClientRect().width`
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="Hide host directory"]').click()`
    )
    await waitFor(
      win,
      `document.querySelector('input[aria-label="Search"]').closest('[data-slot="chrome-row"]').getBoundingClientRect().width > ${toolbarWidth + 200}`
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="Show host directory"]').click()`
    )
    await waitFor(
      win,
      `Math.abs(document.querySelector('input[aria-label="Search"]').closest('[data-slot="chrome-row"]').getBoundingClientRect().width - ${toolbarWidth}) < 2`
    )
    await win.webContents.executeJavaScript(`
      [...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'Hosts').click();
      [...document.querySelectorAll('span')].find(e => e.textContent.trim() === 'Manual test').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));
    `)
    await waitFor(
      win,
      `document.querySelector('[role="dialog"]')?.textContent.includes('Manual Login')`
    )
    await inspectDialog('manual-login')
    await win.webContents.executeJavaScript(
      `document.querySelector('[role="dialog"] button[data-slot="dialog-shell-close"]').click()`
    )
    await waitFor(win, `document.querySelectorAll('[role="dialog"]').length === 2`)
    await win.webContents.executeJavaScript(`
      [...[...document.querySelectorAll('[role="dialog"]')].at(-1).querySelectorAll('button')]
        .find(e => e.textContent === 'Close' && !e.hasAttribute('data-slot')).click()
    `)
    await waitFor(win, `!document.querySelector('[role="dialog"]')`)
    assert(
      await win.webContents.executeJavaScript(`document.body.textContent.includes('New Host')`)
    )
    const gallerySize = win.getContentSize()
    for (const scale of [1, 1.75]) {
      win.setContentSize(980, 620)
      win.webContents.setZoomFactor(scale)
      for (const [name, selector] of [
        [
          'connection',
          `[...document.querySelectorAll('button')].find(e => e.getClientRects().length && e.textContent.trim() === 'New Host')`
        ],
        ['group', `document.querySelector('button[aria-label="New Group"]')`],
        [
          'import',
          `[...document.querySelectorAll('button')].find(e => e.getClientRects().length && e.textContent.trim() === 'Import ~/.ssh/config')`
        ],
        ['note', `document.querySelector('button[aria-label="Server Note"]')`]
      ]) {
        await win.webContents.executeJavaScript(`${selector}.click()`)
        await inspectDialog(`${name}-${scale}`)
        await win.webContents.executeJavaScript(
          `document.querySelector('[data-slot="dialog-shell-close"]').click()`
        )
        await waitFor(win, `!document.querySelector('[data-slot="dialog-shell"]')`)
      }
    }
    win.webContents.setZoomFactor(1)
    win.setContentSize(...gallerySize)
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="Settings"]').click()`
    )
    await waitFor(win, `document.querySelector('#settings-general')`)
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'General').click()`
    )
    await waitFor(win, `document.body.innerText.includes('Accent color')`)
    const settingsCache = path.join(__dirname, '../node_modules/.cache')
    fs.mkdirSync(settingsCache, { recursive: true })
    win.webContents.invalidate()
    await delay(250)
    fs.writeFileSync(
      path.join(settingsCache, 'settings-wide.png'),
      (await win.webContents.capturePage({ stayHidden: true, stayAwake: true })).toPNG()
    )
    const previousSize = win.getContentSize()
    win.setContentSize(980, 620)
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="Show right sidebar"]').click()`
    )
    await delay(250)
    win.webContents.invalidate()
    await delay(150)
    fs.writeFileSync(
      path.join(settingsCache, 'settings-compact.png'),
      (await win.webContents.capturePage({ stayHidden: true, stayAwake: true })).toPNG()
    )
    const settingsLayout = await win.webContents.executeJavaScript(`(() => {
      const container = document.querySelector('#settings-general').closest('[class~="@container"]');
      const edge = container.getBoundingClientRect().right;
      return { width: container.clientWidth, scrollWidth: container.scrollWidth, overflow: [...container.querySelectorAll('*')].filter(e => e.getClientRects().length && (e.getBoundingClientRect().right > edge + 1 || e.scrollWidth > e.clientWidth + 1)).slice(0, 12).map(e => ({tag: e.tagName, cls: e.className, width: e.getBoundingClientRect().width, scrollWidth: e.scrollWidth, overflowX: getComputedStyle(e).overflowX})) };
    })()`)
    assert(settingsLayout.scrollWidth <= settingsLayout.width + 1, JSON.stringify(settingsLayout))
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('nav button')].find(e => e.textContent.trim() === 'AI').click()`
    )
    await waitFor(win, `document.querySelector('#settings-ai').getBoundingClientRect().height > 0`)
    await delay(200)
    assert(
      await win.webContents.executeJavaScript(`(() => {
        const container = document.querySelector('#settings-ai').closest('[class~="@container"]');
        return container.scrollWidth <= container.clientWidth + 1;
      })()`),
      'AI settings fit beside the open activity sidebar without horizontal overflow'
    )
    fs.writeFileSync(
      path.join(settingsCache, 'settings-ai-compact.png'),
      (await win.webContents.capturePage({ stayHidden: true, stayAwake: true })).toPNG()
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="Hide right sidebar"]').click()`
    )
    win.setContentSize(...previousSize)
    assert(
      !(await win.webContents.executeJavaScript(
        `document.body.textContent.includes('coming in Phase')`
      ))
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="Settings"]').click()`
    )
    await win.webContents.executeJavaScript(`
      localStorage.setItem('ggterm.sftpWidth', '520');
      localStorage.setItem('ggterm.activityDockWidth', '480');
      localStorage.setItem('ggterm.sessionEditorH', '9999');
      [...document.querySelectorAll('span')].find(e => e.textContent.trim() === 'Remote test').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));
    `)
    await waitFor(win, `document.querySelector('[data-sftp-path="/config.txt"]')`)
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-sftp-path="/config.txt"]').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`
    )
    await waitFor(
      win,
      `document.querySelector('.monaco-editor .native-edit-context') && [...document.querySelectorAll('[role="combobox"]')].some(e => e.getClientRects().length > 0 && e.textContent.includes('GB18030'))`
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('.monaco-editor .native-edit-context').focus()`
    )
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
      enabled: true
    })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'End',
      code: 'End',
      windowsVirtualKeyCode: 35,
      modifiers: process.platform === 'darwin' ? 4 : 2
    })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'End',
      code: 'End',
      windowsVirtualKeyCode: 35,
      modifiers: process.platform === 'darwin' ? 4 : 2
    })
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '\n# smoke saved' })
    await waitFor(
      win,
      `[...document.querySelectorAll('span')].some(e => e.textContent === 'Unsaved')`
    )
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 's',
      code: 'KeyS',
      windowsVirtualKeyCode: 83,
      modifiers: process.platform === 'darwin' ? 4 : 2
    })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 's',
      code: 'KeyS',
      windowsVirtualKeyCode: 83,
      modifiers: process.platform === 'darwin' ? 4 : 2
    })
    await waitFor(
      win,
      `![...document.querySelectorAll('span')].some(e => e.textContent === 'Unsaved') && !document.querySelector('p[role="alert"]')`
    )
    assert(iconv.decode(fixture.files.get('/config.txt'), 'gb18030').includes('# smoke saved'))
    assert(iconv.decode(fixture.files.get('/config.txt'), 'gb18030').includes('服务器配置'))
    await win.webContents.executeJavaScript(
      `document.querySelector('.monaco-editor .native-edit-context').focus()`
    )
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '\n# unsaved' })
    await waitFor(
      win,
      `[...document.querySelectorAll('span')].some(e => e.textContent === 'Unsaved')`
    )
    win.close()
    await waitFor(
      win,
      `document.querySelector('[role="dialog"]')?.textContent.includes('Save and close')`
    )
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('[role="dialog"] button')].find(e => e.textContent === 'Cancel').click()`
    )
    await waitFor(win, `!document.querySelector('[role="dialog"]')`)
    for (let frame = 0; frame < 4; frame++) {
      await win.webContents.capturePage({ stayHidden: true, stayAwake: true })
      await delay(80)
    }
    // Real transport loss: cancellation preserves both the terminal identity and dirty editor.
    fixture.suspend()
    await waitFor(
      win,
      `document.querySelector('[data-testid="host-recovery"]')?.textContent.includes('Cancel connection')`
    )
    fs.writeFileSync(
      path.join(dialogCache, 'reconnecting.png'),
      (await win.webContents.capturePage({ stayHidden: true, stayAwake: true })).toPNG()
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-testid="host-recovery"] button').click()`
    )
    await waitFor(
      win,
      `document.querySelector('[data-testid="host-recovery"] button')?.textContent === 'Reconnect'`
    )
    fixture.resume()
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-testid="host-recovery"] button').click()`
    )
    await waitFor(
      win,
      `!document.querySelector('[data-testid="host-recovery"]') && [...document.querySelectorAll('span')].some(e => e.textContent === 'Connected')`
    )
    await waitFor(win, `document.querySelector('[data-sftp-path="/config.txt"]')`)
    assert(
      await win.webContents.executeJavaScript(
        `[...document.querySelectorAll('span')].some(e => e.textContent === 'Unsaved')`
      ),
      'reconnection preserves dirty editor state'
    )
    const splitter = await win.webContents.executeJavaScript(`(()=>{
      const e=[...document.querySelectorAll('[role="separator"][aria-orientation="vertical"]')].find(e => e.getClientRects().length > 0);
      const r=e.getBoundingClientRect();
      return {x:r.x+1,y:r.y+100,width:Number(e.getAttribute('aria-valuenow'))};
    })()`)
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: splitter.x,
      y: splitter.y
    })
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: splitter.x,
      y: splitter.y,
      button: 'left',
      clickCount: 1
    })
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: splitter.x - 60,
      y: splitter.y,
      button: 'left',
      buttons: 1
    })
    await delay(200)
    assert.equal(
      await win.webContents.executeJavaScript(
        `Number([...document.querySelectorAll('[role="separator"][aria-orientation="vertical"]')].find(e => e.getClientRects().length > 0).getAttribute('aria-valuenow'))`
      ),
      splitter.width,
      'dragging must not resize the workspace'
    )
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: splitter.x - 60,
      y: splitter.y,
      button: 'left',
      clickCount: 1
    })
    await waitFor(
      win,
      `Number([...document.querySelectorAll('[role="separator"][aria-orientation="vertical"]')].find(e => e.getClientRects().length > 0).getAttribute('aria-valuenow')) < ${splitter.width}`
    )
    win.setContentSize(980, 620)
    await waitFor(win, `window.innerWidth === 980 && window.innerHeight === 620`)
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="Quick Commands"]').click()`
    )
    // Hidden windows need frame requests for ResizeObserver and CSS transitions.
    for (let frame = 0; frame < 12; frame++) {
      await win.webContents.capturePage({ stayHidden: true, stayAwake: true })
      await delay(80)
    }
    fs.writeFileSync(
      path.join(settingsCache, 'workspace-layout.png'),
      (await win.webContents.capturePage({ stayHidden: true, stayAwake: true })).toPNG()
    )
    const terminal = await win.webContents.executeJavaScript(
      `(()=>{const e=[...document.querySelectorAll('.xterm')].find(e => e.getBoundingClientRect().width > 0); const r=e.getBoundingClientRect(); return {width:r.width,height:r.height}})()`
    )
    const image = await win.webContents.capturePage()
    const output = path.resolve('node_modules/.cache/electron-smoke.png')
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, image.toPNG())
    assert(terminal.width >= 280 && terminal.height >= 90, JSON.stringify(terminal))
    // Narrow workspaces collapse SFTP without changing the saved desktop preference.
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="Expand SFTP panel"]').click()`
    )
    await waitFor(
      win,
      `document.querySelector('[data-sftp-path="/config.txt"]').getBoundingClientRect().width > 0 && !document.querySelector('[data-sftp-path="/config.txt"]').closest('[inert]')`
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="Collapse SFTP panel"]').click()`
    )
    await waitFor(win, `document.querySelector('button[aria-label="Expand SFTP panel"]')`)
    // Exercise the real composer viewer through isolated, session-scoped IPC fixtures.
    let executionTasks = [
      {
        executionId: 'agent-ui-remote',
        sessionId: 'ui-test',
        target: 'remote',
        hostId: 'remote-test',
        command: 'read answer',
        status: 'running',
        output: '',
        cursor: 20,
        truncated: false,
        exitCode: null,
        needsInput: true,
        sensitiveInput: false,
        cancelRequested: false
      },
      {
        executionId: 'agent-ui-other',
        sessionId: 'other-test',
        target: 'remote',
        hostId: 'manual-test',
        command: 'other command',
        status: 'completed',
        output: '',
        cursor: 20,
        truncated: false,
        exitCode: 0,
        needsInput: false,
        sensitiveInput: false,
        cancelRequested: false
      }
    ]
    const terminated = []
    const reads = []
    const handlers = {
      list: (_event, owner) => {
        assert(owner)
        return executionTasks.filter((task) => task.sessionId === owner)
      },
      read: (_event, owner, id) => {
        const task = executionTasks.find(
          (task) => task.executionId === id && task.sessionId === owner
        )
        assert(task, 'reads must belong to the selected AI conversation')
        reads.push([owner, id])
        return { ...task, output: 'Background shell ready\r\nEnter choice: ' }
      },
      terminate: (_event, owner, id) => {
        assert(executionTasks.some((task) => task.executionId === id && task.sessionId === owner))
        terminated.push(id)
        executionTasks = executionTasks.map((task) =>
          task.executionId === id
            ? { ...task, status: 'completed', exitCode: 0, terminationRequested: true }
            : task
        )
      }
    }
    for (const [name, handler] of Object.entries(handlers)) {
      ipcMain.removeHandler('execution:' + name)
      ipcMain.handle('execution:' + name, handler)
    }
    await delay(600)
    assert.deepEqual(reads, [], 'background execution must not steal terminal focus')
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="AI Assistant"]').click()`
    )
    await waitFor(
      win,
      `[...document.querySelectorAll('[role="button"]')].some(e => e.textContent.includes('Viewer one'))`
    )
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('[role="button"]')].find(e => e.textContent.includes('Viewer one')).click()`
    )
    await waitFor(win, 'document.querySelector(\'button[aria-label="Execution sessions"]\')')
    await win.webContents.executeJavaScript(
      'document.querySelector(\'button[aria-label="Execution sessions"]\').click()'
    )
    await waitFor(win, `document.querySelector('[aria-label="Read-only shell output"] .xterm')`)
    assert(reads.some(([owner, id]) => owner === 'ui-test' && id === 'agent-ui-remote'))
    assert(!reads.some(([owner]) => owner === 'other-test'))
    assert.equal(
      await win.webContents.executeJavaScript(
        "'input' in window.aterm.executions || 'resize' in window.aterm.executions"
      ),
      false
    )
    const agentScreenshot = path.resolve('node_modules/.cache/execution-viewer.png')
    fs.writeFileSync(agentScreenshot, (await win.webContents.capturePage()).toPNG())
    const closeAgentTab = `[...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'agent ui-tes · agent-').parentElement.querySelector('button[aria-label="Close"]').click()`
    await win.webContents.executeJavaScript(closeAgentTab)
    await waitFor(
      win,
      `document.querySelector('[role="dialog"]')?.textContent.includes('Close agent tab')`
    )
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('[role="dialog"] button')].find(e => e.textContent === 'Cancel').click()`
    )
    await waitFor(win, `!document.querySelector('[role="dialog"]')`)
    assert.deepEqual(terminated, [], 'canceling tab closure must not terminate anything')
    await win.webContents.executeJavaScript(closeAgentTab)
    await waitFor(
      win,
      `document.querySelector('[role="dialog"]')?.textContent.includes('Close agent tab')`
    )
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('[role="dialog"] button')].find(e => e.textContent === 'Close' && !e.hasAttribute('data-slot')).click()`
    )
    await waitFor(
      win,
      `!document.querySelector('[role="dialog"]') && ![...document.querySelectorAll('button')].some(e => e.textContent.trim() === 'agent ui-tes · agent-')`
    )
    assert.deepEqual(terminated, ['agent-ui-remote'])
    // Finished executions remain available when the user explicitly reopens the viewer.
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="Execution sessions"]').click()`
    )
    await waitFor(win, `document.querySelector('[aria-label="Read-only shell output"] .xterm')`)
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="Back to sessions"]').click()`
    )
    await waitFor(
      win,
      `[...document.querySelectorAll('[role="button"]')].some(e => e.textContent.includes('Viewer two'))`
    )
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('[role="button"]')].find(e => e.textContent.includes('Viewer two')).click()`
    )
    await waitFor(win, `document.querySelector('button[aria-label="Execution sessions"]')`)
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="Execution sessions"]').click()`
    )
    await waitFor(
      win,
      `document.querySelector('[aria-label="Read-only shell output"] .xterm') && [...document.querySelectorAll('button')].some(e => e.textContent.trim() === 'agent other- · agent-')`
    )
    assert(reads.some(([owner, id]) => owner === 'other-test' && id === 'agent-ui-other'))
    assert.deepEqual(terminated, ['agent-ui-remote'])
    let fixtureRevision = (
      await win.webContents.executeJavaScript('window.aterm.hosts.runtimeSnapshot()')
    ).revision
    const sendConnectionState = (hostId, phase) =>
      win.webContents.send('connections:state', {
        state: {
          hostId,
          phase,
          since: Date.now(),
          jumpIds: [],
          owner: 'user',
          connectionId: `fixture:${hostId}`,
          generation: 1,
          revision: ++fixtureRevision,
          closed: false
        }
      })
    for (const [hostId, phase] of [
      ['topo-green', 'connected'],
      ['topo-amber', 'connecting'],
      ['topo-red', 'offline']
    ]) {
      sendConnectionState(hostId, phase)
    }
    win.webContents.send('ai:event', {
      sessionId: 'other-test',
      type: 'chunk',
      turnId: 'topo-turn',
      chunk: {
        type: 'tool-input-available',
        toolCallId: 'topo-tool',
        toolName: 'execute',
        input: { hostId: 'topo-green' }
      }
    })
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="Connection graph"]').click()`
    )
    await waitFor(
      win,
      "document.querySelector('.topo-packet') && document.querySelector('.topo-edge-dialing') && document.querySelector('.topo-edge-failed')"
    )
    await delay(1400)
    const viewport = await win.webContents.executeJavaScript(
      "document.querySelector('.react-flow__viewport').style.transform"
    )
    assert(
      await win.webContents.executeJavaScript(`(() => {
      const canvas = document.querySelector('.react-flow').getBoundingClientRect();
      return [...document.querySelectorAll('.react-flow__node')].every(node => {
        const r = node.getBoundingClientRect();
        return r.left >= canvas.left && r.right <= canvas.right && r.top >= canvas.top && r.bottom <= canvas.bottom;
      });
    })()`),
      'automatic layout fits the newly added nodes'
    )
    sendConnectionState('topo-amber', 'connected')
    await delay(1000)
    assert.equal(
      await win.webContents.executeJavaScript(
        "document.querySelector('.react-flow__viewport').style.transform"
      ),
      viewport,
      'status changes preserve the viewport'
    )
    assert.equal(
      await win.webContents.executeJavaScript(
        `document.querySelector('input[aria-label="Link spacing"]').getBoundingClientRect().width`
      ),
      0,
      'topology view sliders are collapsed by default'
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="View options"]').click()`
    )
    await waitFor(
      win,
      `document.querySelector('input[aria-label="Link spacing"]').getBoundingClientRect().width > 0`
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="View options"]').click();
       document.querySelector('button[aria-label="Zoom out"]').click()`
    )
    await waitFor(
      win,
      `document.querySelector('.react-flow__viewport').style.transform !== ${JSON.stringify(viewport)}`
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="Fit view"]').click()`
    )
    await delay(1400)
    const topologyScreenshot = path.resolve('node_modules/.cache/topology.png')
    fs.writeFileSync(topologyScreenshot, (await win.webContents.capturePage()).toPNG())
    ipcMain.removeHandler('host:connectionSessions')
    ipcMain.handle('host:connectionSessions', (_event, hostIds) => [
      { hostId: hostIds[0], owner: 'user', connectionId: '94f5e5c5-3513-43d9-9ad0-5629f5868261' },
      { hostId: hostIds[0], owner: 'agent', connectionId: 'a5f9e320-5a5b-4999-b2d7-d3cf4aeecc08' },
      { hostId: hostIds[0], owner: 'agent', connectionId: '2d49d349-96d0-4f1d-a72f-b55a85ebde73' }
    ])
    await win.webContents.executeJavaScript(
      "[...document.querySelectorAll('header button')].find(e => e.textContent.trim() === 'Remote test').parentElement.querySelector('button[aria-label=\"Close\"]').click()"
    )
    await waitFor(
      win,
      'document.querySelectorAll(\'[role="dialog"] input[type="checkbox"]\').length === 3'
    )
    assert.deepEqual(
      await win.webContents.executeJavaScript(
        '[...document.querySelectorAll(\'[role="dialog"] input[type="checkbox"]\')].map(e => e.checked)'
      ),
      [true, false, false]
    )
    await win.webContents.executeJavaScript(
      'document.querySelectorAll(\'[role="dialog"] input[type="checkbox"]\')[1].click()'
    )
    const closeConnectionsScreenshot = path.resolve('node_modules/.cache/close-connections.png')
    await delay(300)
    fs.writeFileSync(closeConnectionsScreenshot, (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript(
      "[...document.querySelectorAll('[role=\"dialog\"] button')].find(e => e.textContent === 'Cancel').click()"
    )
    let liveRows = [
      { hostId: 'remote-test', owner: 'user', connectionId: 'user-live', shellCount: 2 },
      {
        hostId: 'remote-test',
        owner: 'agent',
        connectionId: 'agent-live-one',
        sessionId: 'ui-test',
        shellCount: 1
      },
      {
        hostId: 'remote-test',
        owner: 'agent',
        connectionId: 'agent-live-two',
        sessionId: 'other-test',
        shellCount: 1
      }
    ].map((row) => ({ ...row, phase: 'connected', since: Date.now() }))
    ipcMain.removeHandler('host:connectionSessions')
    ipcMain.handle('host:connectionSessions', (_event, ids) =>
      liveRows.filter((row) => ids.includes(row.hostId))
    )
    const closedIds = []
    ipcMain.removeHandler('host:closeConnections')
    ipcMain.handle('host:closeConnections', (_event, hostId, ids) => {
      assert.equal(hostId, 'remote-test')
      closedIds.push(...ids)
      liveRows = liveRows.filter((row) => !ids.includes(row.connectionId))
      return { userClosed: false }
    })
    win.setContentSize(1440, 850)
    ipcMain.removeAllListeners('perf:watch')
    await win.webContents.executeJavaScript(
      "window.aterm.connections.update('remote-test', { perfDisabled: false })"
    )
    await win.webContents.executeJavaScript(
      'document.querySelector(\'[role="switch"][aria-label="Performance monitor"]\').click()'
    )
    win.webContents.send('perf:sample', {
      hostId: 'remote-test',
      t: Date.now(),
      osName: 'Ubuntu',
      cpuPct: 12,
      memPct: 38,
      diskPct: 46,
      cores: 4,
      memTotal: 8 * 1024 ** 3,
      diskTotal: 128 * 1024 ** 3,
      swapPct: null,
      netRx: 12000,
      netTx: 3000
    })
    await win.webContents.executeJavaScript(
      `document.querySelector('header button[aria-label="Hosts"]').click()`
    )
    await waitFor(
      win,
      'document.querySelector(\'button[aria-label="Connections for Remote test"]\')'
    )
    await win.webContents.executeJavaScript(
      'document.querySelector(\'button[aria-label="Connections for Remote test"]\').click()'
    )
    await waitFor(win, 'document.querySelector(\'input[aria-label="agent-live-one"]\')')
    assert.equal(
      await win.webContents.executeJavaScript(
        'document.querySelector(\'input[aria-label="agent-live-one"]\').checked'
      ),
      false
    )
    await win.webContents.executeJavaScript(
      'document.querySelector(\'input[aria-label="agent-live-one"]\').click()'
    )
    const liveConnectionsScreenshot = path.resolve('node_modules/.cache/live-connections.png')
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="AI Assistant"]').click()`
    )
    await waitFor(
      win,
      `document.querySelector('[data-host-id="remote-test"] [data-column="performance"]')`
    )
    await delay(300)
    assert(
      await win.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('[data-host-id="remote-test"]')].find(e => e.querySelector('[data-column="actions"]'));
      const metrics = row.querySelector('[data-column="performance"]');
      const actions = row.querySelector('[data-column="actions"]');
      const left = Math.min(...[...actions.querySelectorAll('button')].map(e => e.getBoundingClientRect().left));
      return [...metrics.querySelectorAll('span')].every(e => e.getBoundingClientRect().right <= left);
    })()`),
      'metrics must not overlap connection actions'
    )
    fs.writeFileSync(liveConnectionsScreenshot, (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript(
      "[...document.querySelectorAll('button')].find(e => e.textContent === 'Close selected (1)').click()"
    )
    await waitFor(win, 'document.querySelector(\'[role="dialog"]\')')
    assert.deepEqual(closedIds, [])
    await win.webContents.executeJavaScript(
      "[...document.querySelectorAll('[role=\"dialog\"] button')].find(e => e.textContent === 'Close' && !e.hasAttribute('data-slot')).click()"
    )
    await waitFor(win, '!document.querySelector(\'input[aria-label="agent-live-one"]\')')
    assert.deepEqual(closedIds, ['agent-live-one'])
    await delay(900) // Include delayed completion/resize cleanup in the regression window.
    assert.deepEqual(editorLifetimeErrors, [], 'Monaco must not register listeners after disposal')
    assert(
      await win.webContents.executeJavaScript(
        '!!document.querySelector(\'input[aria-label="user-live"]\') && !!document.querySelector(\'input[aria-label="agent-live-two"]\')'
      )
    )
    // User transport selection must still protect its unsaved editor.
    await win.webContents.executeJavaScript(
      'document.querySelector(\'input[aria-label="user-live"]\').click()'
    )
    await win.webContents.executeJavaScript(
      "[...document.querySelectorAll('button')].find(e => e.textContent === 'Close selected (1)').click()"
    )
    await waitFor(
      win,
      "document.querySelector('[role=\"dialog\"]')?.textContent.includes('Save and close')"
    )
    await win.webContents.executeJavaScript(
      "[...document.querySelectorAll('[role=\"dialog\"] button')].find(e => e.textContent === 'Cancel').click()"
    )
    assert.deepEqual(closedIds, ['agent-live-one'])
    const metrics = {
      platform: process.platform,
      recordedAt: new Date().toISOString(),
      startupMs,
      mainRssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      scenarioMs: Date.now() - launchedAt
    }
    fs.writeFileSync(
      path.join(__dirname, '../node_modules/.cache/desktop-metrics.json'),
      JSON.stringify(metrics, null, 2)
    )
    console.log(
      JSON.stringify({
        status: 'passed',
        metrics,
        checks: [
          'real renderer startup',
          'host directory collapse frees workspace width and restores its layout',
          'manual login cancellation',
          'settings page navigation',
          'compact settings with sidebar preserves content without horizontal overflow',
          'SSH/SFTP connection',
          'GB18030 auto-detection and save round trip',
          'native close preserves dirty files',
          'transport loss, cancellation, and manual reconnect preserve terminals and dirty files',
          'splitter commits dimensions only on release',
          '980px layout, responsive SFTP overlay, and usable terminal',
          'background execution preserves focus, per-conversation read-only tabs, and explicit termination'
        ],
        screenshot: output,
        agentScreenshot,
        topologyScreenshot,
        closeConnectionsScreenshot,
        liveConnectionsScreenshot
      })
    )
    // macOS 主应用关闭最后一个窗口后仍常驻；测试窗口关闭即退出测试进程。
    win.once('closed', () => app.quit())
    win.close()
    await waitFor(
      win,
      `document.querySelector('[role="dialog"]')?.textContent.includes('Discard and close')`
    )
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('[role="dialog"] button')].find(e => e.textContent === 'Discard and close').click()`
    )
  }
  win.webContents.once('did-finish-load', () => {
    run().catch((error) => {
      console.error(error)
      app.exit(1)
    })
  })
})
setTimeout(
  () => {
    console.error('Electron smoke test timed out')
    app.exit(1)
  },
  Number(process.env.GGTERM_SMOKE_TIMEOUT_MS) || 30000
).unref()
require('./ssh-fixture.cjs')
  .startFixture()
  .then((server) => {
    fixture = server
    const store = JSON.parse(fs.readFileSync(path.join(root, 'connections.json'), 'utf8'))
    store.connections.push({
      ...store.connections[0],
      id: 'remote-test',
      name: 'Remote test',
      port: fixture.port,
      authType: 'password'
    })
    fs.writeFileSync(path.join(root, 'connections.json'), JSON.stringify(store))
    fs.writeFileSync(
      path.join(root, 'secrets.json'),
      JSON.stringify({
        secrets: { 'remote-test': ['plain:' + Buffer.from('test').toString('base64'), '', ''] }
      })
    )
    app.on('will-quit', () => fixture.close())
    launchedAt = Date.now()
    require('../out/main/index.js')
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
