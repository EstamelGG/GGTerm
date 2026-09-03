const { app, utilityProcess } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { c } = require('tar')
const assert = require('node:assert/strict')
app
  .whenReady()
  .then(async () => {
    const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'aterm-worker-test-'))
    try {
      const source = path.join(root, 'source')
      const dest = path.join(root, 'dest')
      await fs.mkdir(source)
      await fs.mkdir(dest)
      await fs.writeFile(path.join(source, '中文.txt'), 'archive worker success')
      const file = path.join(root, 'file.tar')
      await c({ file, cwd: source }, ['中文.txt'])
      const run = (cancel) =>
        new Promise((resolve, reject) => {
          const child = utilityProcess.fork(path.resolve('out/main/tarWorker.js'), [file, dest], {
            stdio: 'pipe'
          })
          child.stderr.on('data', (data) => process.stderr.write(data))
          child.once('spawn', () => {
            if (cancel) child.kill()
          })
          child.once('exit', resolve)
          setTimeout(() => {
            child.kill()
            reject(new Error('worker did not exit'))
          }, 5000).unref()
        })
      assert.equal(await run(false), 0)
      assert.equal(await fs.readFile(path.join(dest, '中文.txt'), 'utf8'), 'archive worker success')
      await run(true)
      console.log('PASS: packaged worker extraction and process cancellation')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
