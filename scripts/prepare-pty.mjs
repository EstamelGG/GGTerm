// node-pty 1.1.0's macOS prebuilt spawn-helper ships without its executable bit.
// Fix at install/build time, never mutate an installed/signed application at runtime.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { patchWindowsPty } from './pty-windows-patch.mjs'
const root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
for (const arch of ['arm64', 'x64']) {
  const helper = join(root, 'prebuilds', `darwin-${arch}`, 'spawn-helper')
  if (existsSync(helper)) chmodSync(helper, 0o755)
}
const agentPath = join(root, 'lib', 'windowsPtyAgent.js')
const helperPath = join(root, 'lib', 'conpty_console_list_agent.js')
const agent = readFileSync(agentPath, 'utf8').replace(/\r\n/g, '\n')
const helper = readFileSync(helperPath, 'utf8').replace(/\r\n/g, '\n')
// Validate both targets before writing either file; repeat installation is safe.
const patched = patchWindowsPty(agent, helper)
if (patched.agent !== agent) writeFileSync(agentPath, patched.agent)
if (patched.helper !== helper) writeFileSync(helperPath, patched.helper)
