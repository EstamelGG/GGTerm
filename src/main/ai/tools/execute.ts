import { z } from 'zod'
import { defineTool } from './shared'
import { executions } from '../exec'
import { intentSchema, type AnyTool } from './shared'

const cursor = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Cursor from the previous result; only new output is returned')
const waitMs = z
  .number()
  .int()
  .min(0)
  .max(60000)
  .optional()
  .describe(
    'Max milliseconds to wait this call, default 60000; the process is kept on timeout, 0 returns immediately'
  )
// Runtime tool discovery requires an object at the schema root. Keep action-specific
// validation in the handler; a root oneOf causes the runtime to silently omit the tool.
export const executeParameters = z.object({
  action: z.enum(['start', 'poll', 'input', 'cancel', 'list']),
  description: intentSchema,
  hostId: z.string().optional().describe('Required by remote start; from list_hosts'),
  command: z
    .string()
    .optional()
    .describe('First command fed to the remote shell after start; omit to just open a plain shell'),
  executionId: z.string().optional().describe('Required by poll/input/cancel'),
  input: z.string().min(1).optional().describe('Required by input; must end with a newline'),
  cursor,
  waitMs
})

const executeRequest = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    hostId: z.string().min(1),
    command: z.string().default(''),
    waitMs
  }),
  z.object({ action: z.literal('poll'), executionId: z.string(), cursor, waitMs }),
  z.object({
    action: z.literal('input'),
    executionId: z.string(),
    input: z.string().min(1),
    cursor,
    waitMs
  }),
  z.object({ action: z.literal('cancel'), executionId: z.string(), cursor, waitMs }),
  z.object({ action: z.literal('list') })
])

/** 执行域：远端后台 shell（start/poll/input/cancel/list）；本机执行已移除 */
export const executeTools: AnyTool[] = [
  defineTool('execute', {
    description:
      "Background remote command execution. start opens an interactive remote shell on hostId (from list_hosts), optionally feeding command as the first input. Local execution is not supported. No user terminal tab is ever opened. The shell survives after a command finishes: keep using the same executionId to send more input or answer interactive prompts via input (must end with a newline) — cwd, env and login state are preserved. Output is collected continuously; a suspected prompt is checked every 5s with up to 60s wait by default. A detected prompt is NOT proof of success. running only means the shell is alive; completed/exitCode describe only the shell exiting, not the foreground command. The user can view output in this session's execution list (read-only) or terminate it, but cannot type there. A password/verification-code prompt parks this call instead of returning: an input card appears in the chat and the user submits the value there themselves — it never reaches you — so the call resumes only after they act. The returned snapshot then carries humanInputOutcome: submitted = the user filled it in (read the new output and continue), cancelled/expired = they gave up (terminationRequested is set; do not rerun). Never submit sensitive input through the model and never ask for the secret in chat. terminationRequested/unknown forbid further operations or reruns. cancel sends Ctrl-C — it usually keeps the shell and never rolls back. Stopping the agent or closing the viewer does not close the background shell. list returns all executions of this AI session.",
    parameters: executeParameters,
    handler: async (input, invocation) => {
      const args = executeRequest.parse(input)
      const owner = invocation.sessionId
      if (args.action === 'list') return executions.list(owner)
      if (args.action !== 'poll' && invocation.signal?.aborted)
        throw new Error('Request cancelled; no action taken')
      if (args.action === 'start') {
        const id = executions.start(owner, {
          target: 'remote',
          hostId: args.hostId,
          command: args.command
        })
        return executions.wait(owner, id, 0, args.waitMs, invocation.signal)
      }
      if (args.action === 'input') {
        // 本次输入的输出起点切片：卡片响应只含本次命令的回显与新输出，不混入之前命令的内容
        const from = executions.input(owner, args.executionId, args.input)
        return executions.wait(owner, args.executionId, from, args.waitMs, invocation.signal)
      }
      if (args.action === 'cancel') executions.cancel(owner, args.executionId)
      return executions.wait(owner, args.executionId, args.cursor, args.waitMs, invocation.signal)
    }
  })
]

export const executeTool = executeTools[0]!
