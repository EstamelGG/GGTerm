const assert = require('node:assert/strict')
const { app } = require('electron')
const pty = require('node-pty')
const { join } = require('node:path')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const terminals = new Set()
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
async function waitFor(check, label) {
  const until = Date.now() + 8000
  while (Date.now() < until) {
    if (check()) return
    await delay(30)
  }
  throw new Error(`Timeout: ${label}`)
}
function spawn() {
  const terminal = pty.spawn(join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/q'], {
    cols: 80,
    rows: 24,
    env: process.env
  })
  terminals.add(terminal)
  terminal.onExit(() => terminals.delete(terminal))
  terminal.onData(() => {})
  return terminal
}
const deadline = setTimeout(() => {
  console.error('PTY cleanup timed out')
  app.exit(1)
}, 45000)
app
  .whenReady()
  .then(async () => {
    if (process.platform !== 'win32') {
      console.log('Windows PTY cleanup regression skipped on this platform')
      return
    }
    const survivor = spawn()
    let output = ''
    survivor.onData((data) => {
      output += data
    })
    // Immediate/repeated kill while helper startup is pending; sibling must survive.
    for (let i = 0; i < 8; i++) {
      const terminal = spawn()
      terminal.kill()
      terminal.kill()
      await waitFor(() => !alive(terminal.pid), `rapid close ${i}`)
    }
    // Natural shell exit races cleanup too.
    for (let i = 0; i < 3; i++) {
      const terminal = spawn()
      terminal.write('exit\r')
      await waitFor(() => !alive(terminal.pid), 'natural exit')
      terminal.kill()
    }
    const tree = spawn()
    let treeOutput = ''
    tree.onData((data) => {
      treeOutput += data
    })
    tree.write(
      `powershell.exe -NoLogo -NoProfile -Command "$p = Start-Process -FilePath ([IO.Path]::Combine($env:SystemRoot,'System32','ping.exe')) -ArgumentList '127.0.0.1','-t' -NoNewWindow -PassThru; Write-Output ('CHILD_' + $p.Id); Wait-Process -Id $p.Id"\r`
    )
    await waitFor(() => /CHILD_(\d+)/.test(treeOutput), 'child PID')
    const childPid = Number(treeOutput.match(/CHILD_(\d+)/)[1])
    assert.ok(alive(childPid))
    tree.kill()
    await waitFor(() => !alive(tree.pid) && !alive(childPid), 'process tree cleanup')
    survivor.write('echo SURVIVOR_OK\r')
    await waitFor(() => output.includes('SURVIVOR_OK'), 'sibling remains usable')
    assert.ok(alive(survivor.pid))
    survivor.kill()
    await waitFor(() => !alive(survivor.pid), 'survivor cleanup')
    // Allow the asynchronous console helpers to report failures before exiting.
    await delay(1000)
    console.log(
      'Windows PTY cleanup passed: rapid/repeated close, natural exit, process tree and sibling isolation'
    )
  })
  .then(() => {
    clearTimeout(deadline)
    app.exit(0)
  })
  .catch((error) => {
    for (const terminal of terminals) {
      try {
        terminal.kill()
      } catch {
        /* already gone */
      }
    }
    console.error(error)
    clearTimeout(deadline)
    app.exit(1)
  })
