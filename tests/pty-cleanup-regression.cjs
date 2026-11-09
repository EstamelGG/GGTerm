const { spawnSync } = require('node:child_process')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(require('electron'), ['tests/pty-cleanup-smoke.cjs'], {
  env,
  windowsHide: true,
  encoding: 'utf8',
  timeout: 55000
})
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
if (result.error) console.error(result.error)
// Native helper errors must fail regression even if Electron's main assertions pass.
process.exitCode =
  result.error ||
  result.status !== 0 ||
  /AttachConsole failed|node-pty console (?:cleanup|enumeration) failed/.test(result.stderr || '')
    ? 1
    : 0
