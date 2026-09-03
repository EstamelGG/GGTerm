import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { shellDirectoryCommand } from '../src/shared/sftpPath'

it('changes directories safely with spaces, quotes, shell metacharacters and a leading dash', () => {
  const root = mkdtempSync(join(tmpdir(), 'aterm-dir-'))
  try {
    for (const name of ['My Projects', "it's a dir", 'a;echo injected', '$(echo injected)', '-P']) {
      const path = join(root, name)
      mkdirSync(path)
      for (const input of [path, name, `~/${name}`]) {
        const result = execFileSync(
          '/bin/sh',
          ['-c', `${shellDirectoryCommand(input)} && pwd -P`],
          {
            cwd: root,
            env: { ...process.env, HOME: root },
            encoding: 'utf8'
          }
        )
        expect(result.trim()).toBe(realpathSync(path))
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
