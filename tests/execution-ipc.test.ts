import { expect, it, vi } from 'vitest'
import { registerExecutionIpc } from '../src/main/ai/executionIpc'
const handle = vi.hoisted(() => vi.fn())
const executions = vi.hoisted(() => ({ list: vi.fn(), snapshot: vi.fn(), close: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle } }))
vi.mock('../src/main/ai/exec', () => ({ executions }))

it('exposes only session-scoped reading and explicit termination, never input or resize', () => {
  registerExecutionIpc()
  const handlers = new Map(handle.mock.calls)
  expect([...handlers.keys()]).toEqual(['execution:list', 'execution:read', 'execution:terminate'])
  expect(() => handlers.get('execution:list')({}, undefined)).toThrow('AI 会话')
  handlers.get('execution:list')({}, 'owner')
  expect(executions.list).toHaveBeenCalledWith('owner')
  handlers.get('execution:read')({}, 'owner', 'task', 5)
  expect(executions.snapshot).toHaveBeenCalledWith('owner', 'task', 5, true)
  handlers.get('execution:terminate')({}, 'owner', 'task')
  expect(executions.close).toHaveBeenCalledWith('owner', 'task')
})
