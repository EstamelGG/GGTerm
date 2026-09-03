/* Real SSH transports: user and two AI conversations must have independent lifetimes. */
const { app } = require('electron')
const { Server, utils } = require('ssh2')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'aterm-isolation-')))
const timeout = setTimeout(() => app.exit(1), 30000)
app
  .whenReady()
  .then(async () => {
    const bundle = path.resolve('node_modules/.cache/connection-isolation.cjs')
    require('esbuild').buildSync({
      stdin: {
        contents: `export * from './src/main/ai/agentLinks'; export * from './src/main/ai/exec'; export * from './src/main/ssh/link';`,
        resolveDir: process.cwd(),
        loader: 'ts'
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external'
    })
    const api = require(bundle)
    const peers = new Set()
    let accepted = 0
    const server = new Server(
      { hostKeys: [utils.generateKeyPairSync('rsa', { bits: 2048 }).private] },
      (peer) => {
        accepted++
        peers.add(peer)
        peer.on('error', () => {})
        peer.on('close', () => peers.delete(peer))
        peer.on('authentication', (ctx) => ctx.accept())
        peer.on('ready', () =>
          peer.on('session', (accept) => {
            const session = accept()
            session.on('pty', (accept) => accept())
            session.on('exec', (accept) => {
              const channel = accept()
              channel.end('Linux\n')
              channel.exit(0)
            })
            session.on('shell', (accept) => {
              const channel = accept()
              channel.on('data', (data) => channel.write(data))
            })
          })
        )
      }
    )
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const conn = {
      id: 'same-host',
      name: 'Isolation',
      host: '127.0.0.1',
      port: server.address().port,
      username: 'test',
      authType: 'password',
      connectTimeout: 5000,
      keepaliveInterval: 5000
    }
    const noop = () => {}
    const user = api.getOrCreateLink(conn, {
      onHostState: noop,
      onShellState: noop,
      onShellData: noop,
      onShellAnnounce: noop,
      onSftpState: noop,
      onSftpTransfer: noop,
      onSftpMeasure: noop
    })
    const a = api.agentConnectionContext.run('ai-a', () => api.getOrCreateAgentLink(conn))
    const b = api.agentConnectionContext.run('ai-b', () => api.getOrCreateAgentLink(conn))
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    try {
      for (const link of [user, a, b]) link.start()
      await Promise.all([user, a, b].map((link) => link.waitForActive()))
      assert.equal(accepted, 3, 'three separate SSH handshakes')
      assert.equal(new Set([user, a, b].map((link) => link.activeClient)).size, 3)
      assert.equal(new Set([user, a, b].map((link) => link.connectionId)).size, 3)
      api.setExecutionClientResolver(async (hostId) => api.getAgentLink(hostId).activeClient)
      const start = (owner) =>
        api.agentConnectionContext.run(owner, () =>
          api.executions.start(owner, { target: 'remote', hostId: conn.id, command: 'ready\n' })
        )
      const idA = start('ai-a'),
        idB = start('ai-b')
      await delay(200)
      assert.deepEqual(api.closeSelectedConnections(conn.id, ['stale-user-id']), {
        userClosed: false
      })
      assert(user.isActive)
      assert.deepEqual(api.closeSelectedConnections(conn.id, [user.connectionId]), {
        userClosed: true
      })
      await delay(100)
      assert(a.isActive && b.isActive, 'closing user transport preserves both agents')
      api.executions.input('ai-a', idA, 'after-user-close\n')
      await delay(100)
      assert(api.executions.snapshot('ai-a', idA).output.includes('after-user-close'))
      api.closeAgentConnection('wrong-host', a.connectionId)
      assert(a.isActive, 'selection cannot cross host scope')
      assert.deepEqual(api.closeSelectedConnections(conn.id, [a.connectionId]), {
        userClosed: false
      })
      await delay(100)
      assert.equal(a.isActive, false)
      assert(b.isActive, 'unselected Agent remains connected')
      assert(api.executions.snapshot('ai-a', idA).terminationRequested)
      assert.equal(api.executions.snapshot('ai-b', idB).terminationRequested, false)
      api.executions.input('ai-b', idB, 'unselected-survives\n')
      await delay(100)
      assert(api.executions.snapshot('ai-b', idB).output.includes('unselected-survives'))
      console.log(
        'PASS: three real SSH connections, user close isolation, selective Agent termination, surviving shell input'
      )
    } finally {
      api.removeLink(conn.id)
      for (const item of api.listAgentConnections())
        api.closeAgentConnection(item.hostId, item.connectionId)
      for (const peer of peers) peer.end()
      server.close()
      clearTimeout(timeout)
    }
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
