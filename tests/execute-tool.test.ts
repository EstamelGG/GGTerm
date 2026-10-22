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
  expect(schema.properties?.action).toMatchObject({
    enum: expect.arrayContaining(['command', 'input'])
  })
  expect(schema.properties).not.toHaveProperty('submit')
})

it('can open a remote shell without immediately entering a command', async () => {
  await executeTool.handler({ action: 'start', hostId: 'host-1', waitMs: 0 }, invocation)
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

it.each([
  ['pwd', 'pwd\n'],
  ['Y', 'Y\n'],
  ['pwd\n', 'pwd\n'],
  ['pwd\r', 'pwd\r'],
  ['pwd\r\n', 'pwd\r\n'],
  ["cat <<'EOF'\nhello\nEOF", "cat <<'EOF'\nhello\nEOF\n"]
])('submits command %j exactly once on the existing shell', async (input, sent) => {
  executions.input.mockReturnValue(42)
  await executeTool.handler(
    { action: 'command', executionId: 'task', command: input, waitMs: 0 },
    invocation
  )
  expect(executions.input).toHaveBeenCalledExactlyOnceWith('owner', 'task', sent)
  expect(executions.wait).toHaveBeenCalledWith('owner', 'task', 42, 0, undefined)
})

it.each(['q', ' ', '\x04', '\x1b[A', 'partial ', 'pwd', 'already\n', '\n', '\r'])(
  'preserves raw input %j byte for byte without an Enter flag',
  async (input) => {
    await executeTool.handler(
      { action: 'input', executionId: 'task', input, waitMs: 0 },
      invocation
    )
    expect(executions.input).toHaveBeenCalledExactlyOnceWith('owner', 'task', input)
  }
)

it.each([
  { action: 'command', executionId: 'task' },
  { action: 'command', executionId: 'task', command: '' },
  { action: 'command', executionId: 'task', command: ' \n' },
  { action: 'command', command: 'pwd' },
  { action: 'command', executionId: '', command: 'pwd' },
  { action: 'command', executionId: 'task', input: 'pwd' }
])('rejects invalid command requests before writing: %j', async (args) => {
  await expect(executeTool.handler(args, invocation)).rejects.toThrow()
  expect(executions.input).not.toHaveBeenCalled()
  expect(executions.start).not.toHaveBeenCalled()
  expect(executions.wait).not.toHaveBeenCalled()
})

it.each(['command', 'input'])('does not send %s after cancellation', async (action) => {
  await expect(
    executeTool.handler(
      { action, executionId: 'task', command: 'pwd', input: '\n' },
      { ...invocation, signal: AbortSignal.abort() }
    )
  ).rejects.toThrow('Request cancelled')
  expect(executions.input).not.toHaveBeenCalled()
})

it('propagates input rejection without opening a replacement shell or retrying', async () => {
  executions.input.mockImplementationOnce(() => {
    throw new Error('Sensitive input cannot be submitted')
  })
  await expect(
    executeTool.handler(
      { action: 'command', executionId: 'task', command: 'pwd', waitMs: 0 },
      invocation
    )
  ).rejects.toThrow('Sensitive input')
  expect(executions.input).toHaveBeenCalledOnce()
  expect(executions.start).not.toHaveBeenCalled()
  expect(executions.wait).not.toHaveBeenCalled()
})
