/* Background interactive remote shells: localhost SSH server backed by a PTY. */
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { Server, Client, utils } = require('ssh2')
const { app } = require('electron')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deadline = setTimeout(() => {
  console.error('Execution smoke timed out')
  app.exit(1)
}, 45000)

app
  .whenReady()
  .then(async () => {
    const bundle = path.resolve('node_modules/.cache/execution-smoke.cjs')
    fs.mkdirSync(path.dirname(bundle), { recursive: true })
    require('esbuild').buildSync({
      entryPoints: ['src/main/ai/exec.ts'],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      logLevel: 'silent'
    })
    const { executions, setExecutionClientResolver } = require(bundle)
    const { spawn } = require('node-pty')
    const win = process.platform === 'win32'
    if (win) process.env.SHELL = 'powershell.exe'
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aterm-shared-shell-'))
    const peers = new Set()
    let shellOpens = 0
    let remoteCloses = 0
    const server = new Server(
      { hostKeys: [utils.generateKeyPairSync('rsa', { bits: 2048 }).private] },
      (peer) => {
        peers.add(peer)
        peer.on('error', () => {})
        peer.on('close', () => peers.delete(peer))
        peer.on('authentication', (context) => context.accept())
        peer.on('ready', () =>
          peer.on('session', (accept) => {
            const session = accept()
            session.on('pty', (accept) => accept())
            session.on('shell', (accept) => {
              shellOpens++
              const stream = accept()
              const pty = spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoLogo'] : ['-i'], {
                cwd,
                env: process.env,
                cols: 120,
                rows: 30,
                name: 'xterm-256color'
              })
              let closed = false
              pty.onData((text) => {
                if (!closed) stream.write(text)
              })
              pty.onExit(({ exitCode }) => {
                if (!closed) {
                  stream.exit(exitCode)
                  stream.end()
                }
              })
              stream.on('data', (data) => pty.write(data.toString()))
              stream.on('close', () => {
                closed = true
                remoteCloses++
                pty.kill()
              })
              session.on('window-change', (accept, _reject, size) => {
                accept?.()
                pty.resize(size.cols, size.rows)
              })
            })
          })
        )
      }
    )
    const client = new Client()
    const owner = 'execution-smoke'
    async function waitOutput(id, pattern, cursor = 0) {
      const until = Date.now() + 4000
      while (Date.now() < until) {
        const view = executions.snapshot(owner, id, cursor)
        if (pattern.test(view.output)) return view
        await delay(30)
      }
      throw new Error(JSON.stringify(executions.snapshot(owner, id, cursor)))
    }
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      await new Promise((resolve, reject) => {
        client.once('ready', resolve).once('error', reject)
        client.connect({ host: '127.0.0.1', port: server.address().port, username: 'test' })
      })
      setExecutionClientResolver(async () => client)
      const command = win
        ? '$reply = Read-Host "Enter choice"; Write-Output "answer=$reply"'
        : 'printf "Enter choice: "; read reply; printf "answer=%s\\n" "$reply"'
      const id = executions.start(owner, {
        target: 'remote',
        hostId: 'fixture',
        command
      })
      const first = await executions.wait(owner, id)
      assert.equal(first.status, 'running', JSON.stringify(first))
      assert.equal(first.needsInput, true)
      executions.input(owner, id, 'yes\r')
      const answered = await waitOutput(id, /answer=yes/, first.cursor)
      assert.equal(
        answered.status,
        'running',
        'command completion must leave the shared shell alive'
      )
      assert.equal(
        answered.exitCode,
        null,
        'shell exit code must not be confused with a command exit code'
      )
      const change = win
        ? `Set-Location '${cwd}'; $env:ATERM_SHELL_TEST='shared'; Write-Output '__USER_READY__'\r`
        : `cd '${cwd}'; export ATERM_SHELL_TEST=shared; printf '__USER_READY__\\n'\r`
      executions.input(owner, id, change)
      const changed = await waitOutput(id, /\r?\n__USER_READY__\r?\n/, answered.cursor)
      executions.input(
        owner,
        id,
        win
          ? 'Write-Output "__STATE__$pwd|$env:ATERM_SHELL_TEST"\r'
          : 'printf "__STATE__%s|%s\\n" "$PWD" "$ATERM_SHELL_TEST"\r'
      )
      const state = await waitOutput(id, /__STATE__[^\r\n]+\|shared/, changed.cursor)
      assert(state.output.includes(cwd), state.output)
      assert.equal(executions.snapshot(owner, id).status, 'running')
      executions.input(owner, id, 'exit 7\r')
      const ended = await executions.wait(owner, id, state.cursor, 4000)
      assert.equal(ended.status, 'completed', JSON.stringify(ended))
      assert.equal(ended.exitCode, 7)
      const closing = executions.start(owner, {
        target: 'remote',
        hostId: 'fixture',
        command: ''
      })
      while (executions.snapshot(owner, closing).status === 'starting') await delay(10)
      const before = remoteCloses
      executions.close(owner, closing)
      const closed = await executions.wait(owner, closing, 0, 2000)
      assert.equal(closed.terminationRequested, true)
      await delay(100)
      assert(remoteCloses > before)
      assert.equal(shellOpens, 2, 'continuing user and Agent input must reuse the existing shell')
      console.log(
        JSON.stringify({
          status: 'passed',
          checks: [
            'SSH shell request uses an ordinary interactive PTY',
            'commands leave shell alive',
            'Agent background shell retains cwd and environment',
            'exit closes shell with actual exit code',
            'explicit termination closes real SSH terminals'
          ]
        })
      )
    } finally {
      client.destroy()
      for (const peer of peers) peer.end()
      server.close()
      fs.rmSync(cwd, { recursive: true, force: true })
    }
    clearTimeout(deadline)
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    clearTimeout(deadline)
    app.exit(1)
  })
