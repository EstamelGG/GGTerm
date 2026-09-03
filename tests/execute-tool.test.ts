import { beforeEach, expect, it, vi } from 'vitest'
import { executeParameters, executeTool } from '../src/main/ai/executeTool'

const executions = vi.hoisted(() => ({
  start: vi.fn(() => 'task'),
  wait: vi.fn(),
  input: vi.fn(),
  cancel: vi.fn(),
  list: vi.fn(() => [])
}))
vi.mock('../src/main/ai/exec', () => ({ executions }))
const invocation = { sessionId: 'owner', toolCallId: 'call', toolName: 'execute' }
beforeEach(() => vi.clearAllMocks())

it('exposes an object schema with action at the root for runtime discovery', () => {
  const schema = executeParameters.toJSONSchema()
  expect(schema.type).toBe('object')
  expect(schema).not.toHaveProperty('oneOf')
  expect(schema).not.toHaveProperty('anyOf')
  expect(schema.required).toContain('action')
})

it('can open a remote shell without immediately entering a command', async () => {
  await executeTool.handler(
    { action: 'start', hostId: 'host-1', waitMs: 0 },
    invocation
  )
  expect(executions.start).toHaveBeenCalledWith('owner', {
    target: 'remote',
    hostId: 'host-1',
    command: ''
  })
})

it('still rejects missing action-specific arguments before any side effect', async () => {
  await expect(executeTool.handler({ action: 'start' }, invocation)).rejects.toThrow()
  await expect(
    executeTool.handler({ action: 'input', executionId: 'task' }, invocation)
  ).rejects.toThrow()
  expect(executions.start).not.toHaveBeenCalled()
  expect(executions.input).not.toHaveBeenCalled()
})

it('starts and polls the same task after validating a valid request', async () => {
  await executeTool.handler(
    { action: 'start', hostId: 'host-1', command: 'pwd', waitMs: 0 },
    invocation
  )
  expect(executions.start).toHaveBeenCalledOnce()
  expect(executions.wait).toHaveBeenCalledWith('owner', 'task', 0, 0, undefined)
})
