import { beforeEach, expect, it, vi } from 'vitest'
import { judgeCommand } from '../src/main/ai/gate'
import type { AiConfig } from '../src/shared/types'

const mocks = vi.hoisted(() => ({ generateText: vi.fn() }))
vi.mock('ai', () => ({ generateText: mocks.generateText }))
vi.mock('../src/main/ai/provider', () => ({ createChatModel: vi.fn() }))
const config = (approvalLevel: AiConfig['approvalLevel']): AiConfig => ({
  providers: [],
  scenarios: {},
  approvalLevel
})
beforeEach(() =>
  mocks.generateText.mockReset().mockResolvedValue({
    text: '{"verdict":"safe","reason":"mock verdict"}'
  })
)

it.each(['strict', 'default'] as const)(
  '%s requires approval for mutating diagnostic forms',
  async (level) => {
    for (const command of [
      'git branch -D sample',
      'git tag sample',
      'git remote add example https://example.invalid/repo',
      'git diff --output=result.txt',
      'find . -fprint result.txt',
      'env touch result.txt',
      'ip link set eth0 down',
      'date -s 2026-01-01',
      'hostname changed',
      'journalctl --vacuum-time=1s',
      'dmesg -C',
      'tree -o result.txt'
    ]) {
      expect(await judgeCommand(command, config(level)), command).toMatchObject({
        action: 'confirm'
      })
    }
    expect(mocks.generateText).not.toHaveBeenCalled()
  }
)

it.each([
  'ls -la',
  'cat /etc/os-release',
  'ps aux | grep ssh',
  'git status',
  'git branch --list',
  'hostname',
  'date'
])('retains automatic diagnostics: %s', async (command) => {
  expect(await judgeCommand(command, config('strict'))).toMatchObject({ action: 'direct' })
})

it('preserves explicit relaxed mode and gray-command judgment', async () => {
  expect(await judgeCommand('git branch -D sample', config('relaxed'))).toMatchObject({
    action: 'direct'
  })
  expect(await judgeCommand('custom-diagnostic', config('default'))).toMatchObject({
    action: 'direct',
    level: 'gray'
  })
  expect(mocks.generateText).toHaveBeenCalledTimes(1)
})
