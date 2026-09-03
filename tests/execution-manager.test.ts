import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ExecutionManager,
  type ExecutionEvents,
  type ExecutionTransport
} from '../src/main/ai/executionManager'
import type { ExecutionSnapshot, HumanInputRequest, HumanInputResolved } from '../src/shared/execution'

let events: ExecutionEvents
let manager: ExecutionManager
let transport: ExecutionTransport
let connect: ReturnType<typeof vi.fn>
const start = (): string =>
  manager.start('owner', { target: 'remote', hostId: 'host', command: './install.sh' })
beforeEach(() => {
  vi.useFakeTimers()
  transport = { write: vi.fn(), interrupt: vi.fn(), close: vi.fn() }
  connect = vi.fn(async (_input, callbacks: ExecutionEvents) => {
    events = callbacks
    return transport
  })
  manager = new ExecutionManager(connect)
})
afterEach(() => vi.useRealTimers())

describe('execution lifecycle', () => {
  it('a prompt returns control while keeping the shell alive and never fabricates a command exit code', async () => {
    const id = start()
    const pending = manager.wait('owner', id)
    events.data('result\nubuntu@host:~$ ')
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toMatchObject({
      status: 'running',
      needsInput: true,
      exitCode: null
    })
  })
  it('retains every execution record while trimming older output to bound memory use', () => {
    let first = ''
    for (let i = 0; i < 80; i++) {
      const id = start()
      if (i === 0) first = id
      events.data('x'.repeat(128 * 1024))
      events.exit(0)
    }
    expect(manager.list('owner')).toHaveLength(80)
    expect(manager.snapshot('owner', first).status).toBe('completed')
    expect(manager.snapshot('owner', first).truncated).toBe(true)
    manager.close('owner', first)
    expect(manager.list('owner')).toHaveLength(80)
    expect(() => start()).not.toThrow()
    expect(manager.list('other-owner')).toEqual([])
  })
  it('explicit termination closes the transport once and keeps the session record', async () => {
    const id = start()
    await Promise.resolve()
    manager.close('owner', id)
    manager.close('owner', id)
    expect(transport.close).toHaveBeenCalledOnce()
    expect(transport.interrupt).not.toHaveBeenCalled()
    expect(manager.snapshot('owner', id)).toMatchObject({
      terminationRequested: true,
      cancelRequested: true
    })
    expect(manager.list('owner')).toHaveLength(1)
  })

  it('remembers termination while the connection is starting', async () => {
    const id = start()
    manager.close('owner', id)
    expect(connect.mock.calls[0][2].aborted).toBe(true)
    await Promise.resolve()
    expect(transport.close).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledOnce()
  })
  it('returns immediately on process exit without waiting for the five-second check', async () => {
    const id = start()
    const pending = manager.wait('owner', id)
    events.data('done\r\n')
    events.exit(7)
    expect(await pending).toMatchObject({ status: 'completed', exitCode: 7, output: 'done\n' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('wait expiry preserves the original process and input continues it exactly once', async () => {
    const id = start()
    events.data('installed step one\n')
    const pending = manager.wait('owner', id, 0, 5000)
    await vi.advanceTimersByTimeAsync(5000)
    const first = await pending
    expect(first.status).toBe('running')
    expect(transport.interrupt).not.toHaveBeenCalled()
    manager.input('owner', id, 'yes\n')
    expect(transport.write).toHaveBeenCalledWith('yes\n')
    events.data('step two\n')
    events.exit(0)
    expect(await manager.wait('owner', id, first.cursor)).toMatchObject({
      output: 'step two\n',
      status: 'completed'
    })
    expect(connect).toHaveBeenCalledOnce()
  })

  it('starts an appended input response at the waiting prompt line instead of mid-line', async () => {
    const id = start()
    await Promise.resolve()
    events.data('total 0\r\nubuntu@host:~$ ')
    const prompt = 'ubuntu@host:~$ '
    const from = manager.input('owner', id, 'ls -la\n')
    expect(transport.write).toHaveBeenCalledWith('ls -la\n')
    // 起点回退到提示符行行首（写入时刻的末尾再减去提示符长度），回显正好落在这一行上
    expect(from).toBe('total 0\r\n'.length)
    const pending = manager.wait('owner', id, from)
    events.data('ls -la\r\ntotal 0\r\nubuntu@host:~$ ')
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toMatchObject({
      output: `${prompt}ls -la\ntotal 0\n${prompt}`,
      truncated: false
    })
  })

  it('keeps the write-time start when the trailing line is not a waiting prompt', async () => {
    const id = start()
    await Promise.resolve()
    events.data('Extracting files')
    expect(manager.input('owner', id, 'y\n')).toBe('Extracting files'.length)
  })

  it('does not treat silence as failure or automatically interrupt', async () => {
    const id = start()
    const pending = manager.wait('owner', id)
    await vi.advanceTimersByTimeAsync(60000)
    expect(await pending).toMatchObject({ status: 'running', needsInput: false })
    expect(transport.interrupt).not.toHaveBeenCalled()
  })

  it('stopping the agent releases only its waiter', async () => {
    const id = start()
    await Promise.resolve()
    const controller = new AbortController()
    const pending = manager.wait('owner', id, 0, 60000, controller.signal)
    controller.abort()
    expect(await pending).toMatchObject({ status: 'running' })
    manager.input('owner', id, 'continue\n')
    expect(transport.write).toHaveBeenCalledOnce()
    expect(transport.interrupt).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('detects and rejects sensitive input without a human-input bypass', async () => {
    const id = start()
    await Promise.resolve()
    events.data('[sudo] pass')
    events.data('word for ubuntu: ')
    const settled: ExecutionSnapshot[] = []
    void manager.wait('owner', id).then((snapshot) => settled.push(snapshot))
    await vi.advanceTimersByTimeAsync(5000)
    // 识别为敏感提示：状态置位但控制权不交回模型（改由人工输入卡片承接）
    expect(manager.snapshot('owner', id)).toMatchObject({
      status: 'running',
      needsInput: true,
      sensitiveInput: true
    })
    expect(settled).toHaveLength(0)
    expect(() => manager.input('owner', id, 'model-secret\n')).toThrow('敏感输入')
    expect(transport.write).not.toHaveBeenCalled()
  })

  it('a cancellation request is not reported as a confirmed exit', async () => {
    const id = start()
    await Promise.resolve()
    manager.cancel('owner', id)
    expect(transport.interrupt).toHaveBeenCalledOnce()
    expect(manager.snapshot('owner', id)).toMatchObject({
      status: 'running',
      cancelRequested: true,
      exitCode: null
    })
  })

  it('marks lost channels unknown without rerunning or claiming success', async () => {
    const id = start()
    events.data('changed config\n')
    const pending = manager.wait('owner', id)
    events.lost('connection lost')
    expect(await pending).toMatchObject({
      status: 'unknown',
      exitCode: null,
      output: 'changed config\n'
    })
    expect(() => manager.input('owner', id, '\n')).toThrow()
    expect(connect).toHaveBeenCalledOnce()
  })

  it('notifies background completion only when no tool waiter will deliver the result', async () => {
    const notify = vi.fn()
    manager.onBackgroundFinish = notify
    const foreground = start()
    const pending = manager.wait('owner', foreground)
    events.exit(0)
    await pending
    expect(notify).not.toHaveBeenCalled()
    const background = start()
    events.exit(0)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: background, status: 'completed' })
    )
  })

  it('rejects premature input, wrong owners, and invalid cursors', () => {
    const id = start()
    expect(() => manager.input('owner', id, 'lost\n')).toThrow('尚未就绪')
    expect(() => manager.snapshot('other-owner', id)).toThrow('不属于')
    expect(() => manager.cancel('other-owner', id)).toThrow('不属于')
    expect(() => manager.snapshot('owner', id, 10)).toThrow('游标')
    expect(transport.write).not.toHaveBeenCalled()
  })

  it('bounds retained output and reports truncation without killing the process', () => {
    const id = start()
    events.data('中'.repeat(200000))
    const result = manager.snapshot('owner', id)
    expect(result.output.length).toBeLessThanOrEqual(128 * 1024)
    expect(result.truncated).toBe(true)
    expect(transport.interrupt).not.toHaveBeenCalled()
  })

  it('parks the tool call on a sensitive prompt until the human responds', async () => {
    const requests: HumanInputRequest[] = []
    manager.onHumanInputRequest((request) => requests.push(request))
    const id = start()
    await Promise.resolve()
    events.data('[sudo] password for deploy: ')
    const settled: ExecutionSnapshot[] = []
    void manager.wait('owner', id).then((snapshot) => settled.push(snapshot))
    await vi.advanceTimersByTimeAsync(5000)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      sessionId: 'owner',
      executionId: id,
      hostId: 'host',
      command: './install.sh',
      prompt: '[sudo] password for deploy:'
    })
    expect(manager.pendingHumanInput('owner')).toHaveLength(1)
    expect(manager.pendingHumanInput('other-owner')).toHaveLength(0)
    // 挂起：既不等 60s deadline 返回，也不把控制权交回模型（模型侧零消息注入）
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).toHaveLength(0)
    // agent 通道依旧被拒（人工输入只能由渲染层卡片提交），且不会因此唤醒等待者
    expect(() => manager.input('owner', id, 'model-secret\n')).toThrow('Sensitive input')
    expect(transport.write).not.toHaveBeenCalled()
    expect(settled).toHaveLength(0)
    // 人工提交 → 工具调用立刻交回模型，并带上收尾结果
    manager.submitHumanInput('owner', id, 'hunter2secret\n')
    await Promise.resolve()
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ needsInput: false, humanInputOutcome: 'submitted' })
  })

  it('submits human input straight to the PTY and redacts an echoed value from output', async () => {
    const resolved: HumanInputResolved[] = []
    manager.onHumanInputResolved((info) => resolved.push(info))
    const id = start()
    await Promise.resolve()
    events.data('[sudo] password for deploy: ')
    const pending = manager.wait('owner', id)
    await vi.advanceTimersByTimeAsync(5000)
    manager.submitHumanInput('owner', id, 'hunter2secret\n')
    await pending
    expect(transport.write).toHaveBeenCalledWith('hunter2secret\n')
    // 回执带 sessionId：渲染层按会话过滤待办用
    expect(resolved).toEqual([{ executionId: id, sessionId: 'owner', outcome: 'submitted' }])
    expect(manager.pendingHumanInput('owner')).toHaveLength(0)
    expect(manager.snapshot('owner', id)).toMatchObject({
      needsInput: false,
      sensitiveInput: false
    })
    // 远端若回显：写入输出缓冲前抹成掩码，模型与查看器都看不到明文
    events.data('hunter2secret\r\n')
    const output = manager.snapshot('owner', id).output
    expect(output).not.toContain('hunter2secret')
    expect(output).toContain('••••••••')
    expect(() => manager.submitHumanInput('owner', id, 'again\n')).toThrow(
      'No pending human input'
    )
  })

  it('cancelling a pending request terminates the blocked execution', async () => {
    const outcomes: string[] = []
    manager.onHumanInputResolved((info) => outcomes.push(info.outcome))
    const id = start()
    await Promise.resolve()
    events.data('[sudo] password for deploy: ')
    const pending = manager.wait('owner', id)
    await vi.advanceTimersByTimeAsync(5000)
    manager.cancelHumanInput('owner', id)
    expect(await pending).toMatchObject({
      terminationRequested: true,
      humanInputOutcome: 'cancelled'
    })
    expect(outcomes).toEqual(['cancelled'])
    expect(transport.close).toHaveBeenCalledOnce()
    expect(manager.snapshot('owner', id).terminationRequested).toBe(true)
    expect(transport.write).not.toHaveBeenCalled()
  })

  it('expires an unanswered request after the TTL and terminates the execution', async () => {
    const outcomes: string[] = []
    manager.onHumanInputResolved((info) => outcomes.push(info.outcome))
    const id = start()
    await Promise.resolve()
    events.data('[sudo] password for deploy: ')
    const pending = manager.wait('owner', id)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(await pending).toMatchObject({
      terminationRequested: true,
      humanInputOutcome: 'expired'
    })
    expect(outcomes).toEqual(['expired'])
    expect(transport.close).toHaveBeenCalledOnce()
    expect(manager.pendingHumanInput()).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
