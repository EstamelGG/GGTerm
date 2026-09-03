// node-pty 1.1.0's macOS prebuilt spawn-helper ships without its executable bit.
// Fix at install/build time, never mutate an installed/signed application at runtime.
import { chmodSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
const root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
for (const arch of ['arm64', 'x64']) {
  const helper = join(root, 'prebuilds', `darwin-${arch}`, 'spawn-helper')
  if (existsSync(helper)) chmodSync(helper, 0o755)
}
