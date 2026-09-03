/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * Copilot SDK 嵌入验证脚本（spike，验证后可删）
 *
 * 验证四个硬问题：
 *   ① 进程内 tool handlers（zod v4 schema + handler）
 *   ② BYOK：provider 指向本地 Ollama（openai 兼容），零 GitHub 认证
 *   ③ onPermissionRequest 审批回调（放行只读 / 拒绝危险命令）
 *   ④ 会话持久化：disconnect → 新 client → resumeSession → getEvents()
 *
 * 运行：node scripts/spike-copilot-sdk.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { CopilotClient, ToolSet } from '@github/copilot-sdk'

const OLLAMA_BASE = 'http://localhost:11434/v1'
const MODEL = 'qwen3.8:27b-mlx'
const home = mkdtempSync(join(tmpdir(), 'ggterm-copilot-spike-'))
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)

/** 与 tools.ts 同构的迷你工具面（复刻 aiTools 的字段约定） */
const tools = [
  {
    name: 'spike_list_hosts',
    description: '列出已保存的 SSH 连接（含在线状态）。hostId 的唯一合法来源。',
    parameters: z.object({}),
    skipPermission: true, // 只读白名单 → gate direct
    handler: async () => [
      { id: 'h-web-1', name: 'web-1', host: '10.0.0.11', connected: true },
      { id: 'h-db-1', name: 'db-1', host: '10.0.0.12', connected: false }
    ]
  },
  {
    name: 'spike_exec',
    description: '在远程主机上执行一条命令（非交互）。',
    parameters: z.object({
      hostId: z.string().describe('主机 id，来自 spike_list_hosts'),
      command: z.string()
    }),
    // 不设 skipPermission → 期望触发 permission request，由下面的 handler 审批
    handler: async ({ hostId, command }) => {
      if (command.includes('rm -rf')) throw new Error('模拟执行失败')
      return { hostId, command, stdout: `load average: 0.42, 0.35, 0.31\nup 42 days`, exitCode: 0 }
    }
  }
]

/** 模拟 gate.ts：只读放行、危险拒绝、其余 approve-once */
const permissionHandler = async (request, { sessionId }) => {
  const args = JSON.stringify(request).slice(0, 300)
  log(`🔑 [permission] session=${sessionId.slice(0, 8)} kind=${request.kind} :: ${args}`)
  const json = JSON.stringify(request)
  if (json.includes('rm -rf')) {
    return { kind: 'reject', feedback: '命中危险命令黑名单（spike gate）' }
  }
  return { kind: 'approve-once', approvedInteractively: true }
}

const sessionConfig = () => ({
  model: MODEL,
  provider: { type: 'openai', baseUrl: OLLAMA_BASE }, // Ollama 免密钥
  clientName: 'ggterm-spike',
  tools,
  onPermissionRequest: permissionHandler,
  availableTools: new ToolSet().addCustom('*'), // 禁用全部内置工具，仅暴露自定义 SSH 域工具
  systemMessage: {
    mode: 'append',
    content:
      '你是 GGTerm 的 SSH 运维助手（spike 验证）。hostId 必须来自 spike_list_hosts。一次只执行一条命令。'
  },
  streaming: true
})

function wireEvents(session, tag) {
  session.on((event) => {
    switch (event.type) {
      case 'assistant.message':
        log(`💬 [${tag}] assistant: ${String(event.data.content).slice(0, 160)}`)
        break
      case 'assistant.message_delta':
        process.stdout.write(event.data.deltaContent ?? '')
        break
      case 'permission.requested':
        log(`🔑 [${tag}] permission.requested 事件到达`)
        break
      case 'session.idle':
        log(`✅ [${tag}] session idle`)
        break
      case 'session.error':
        log(`❌ [${tag}] session.error:`, JSON.stringify(event.data).slice(0, 300))
        break
      default:
        log(`· [${tag}] ${event.type}`)
    }
  })
}

async function main() {
  log('== Phase 1: createSession（BYOK + 自定义工具 + 审批）==')
  const client1 = new CopilotClient({ mode: 'empty', baseDirectory: home, logLevel: 'error' })
  await client1.start()
  const status = await client1.getStatus()
  log(`runtime ready: ${status.version ?? 'unknown'}`)

  const session = await client1.createSession(sessionConfig())
  log(`session created: ${session.sessionId}  workspace=${session.workspacePath ?? '(none)'}`)
  wireEvents(session, 'p1')

  const reply = await session.sendAndWait(
    '请先用 spike_list_hosts 查主机，然后用 spike_exec 在 web-1 上执行 uptime 并汇报结果。',
    300_000
  )
  log(`reply: ${String(reply?.data.content ?? '(none)').slice(0, 200)}`)
  const events1 = await session.getEvents()
  log(`event history: ${events1.length} 条；类型分布:`, eventTypeHistogram(events1))

  const sid = session.sessionId
  await session.disconnect()
  const errs = await client1.stop()
  if (errs.length) log('stop errors:', errs)

  log('== Phase 2: 新 client + resumeSession（验证持久化）==')
  const client2 = new CopilotClient({ mode: 'empty', baseDirectory: home, logLevel: 'error' })
  await client2.start()
  const resumed = await client2.resumeSession(sid, sessionConfig())
  wireEvents(resumed, 'p2')
  const events2 = await resumed.getEvents()
  log(`resumed history: ${events2.length} 条（Phase 1 为 ${events1.length}）`)
  const followUp = await resumed.sendAndWait('我刚才在 web-1 上执行了什么命令？', 300_000)
  log(`follow-up reply: ${String(followUp?.data.content ?? '(none)').slice(0, 200)}`)
  await resumed.disconnect()
  await client2.stop()

  log('== SPIKE RESULT: 全部阶段完成 ==')
  process.exit(0)
}

function eventTypeHistogram(events) {
  const m = new Map()
  for (const e of events) m.set(e.type, (m.get(e.type) ?? 0) + 1)
  return Object.fromEntries(m)
}

main().catch((err) => {
  console.error('SPIKE FAILED:', err)
  process.exit(1)
})
