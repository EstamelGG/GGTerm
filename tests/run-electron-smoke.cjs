const { spawn } = require('node:child_process')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [process.argv[2] || 'tests/electron-smoke.cjs'], {
  env,
  stdio: 'inherit',
  windowsHide: true
})
child.once('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.once('exit', (code) => {
  process.exitCode = code ?? 1
})
