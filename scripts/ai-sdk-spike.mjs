// AI SDK 替换 copilot-sdk 可行性 spike（独立脚本，不触碰 src/）：
//   ①第三方模型经 openai-compatible 的 reasoning（thinking）增量透传
//   ②工具 execute 长时间挂起（模拟审批等待 12s）时流不断
//   ③多步工具循环（stopWhen/stepCountIs）正常往返
//
// 用法：
//   SPIKE_API_KEY=xxx node scripts/ai-sdk-spike.mjs [model]
// baseURL/model 缺省读 dev 偏好（~/Library/Application Support/ggterm/preferences.json），
// 也可用 SPIKE_BASE_URL / SPIKE_MODEL 覆盖；model 用位置参数优先级最高。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText, tool, stepCountIs } from 'ai'
import { z } from 'zod'

const argModel = process.argv[2] ?? ''
const apiKey = process.env.SPIKE_API_KEY ?? ''

let baseURL = process.env.SPIKE_BASE_URL ?? ''
let model = process.env.SPIKE_MODEL ?? argModel
if (!baseURL || !model) {
  const prefsPath = join(
    homedir(),
    'Library',
    'Application Support',
    'ggterm',
    'preferences.json'
  )
  if (existsSync(prefsPath)) {
    const ai = JSON.parse(readFileSync(prefsPath, 'utf8')).ai ?? {}
    const chat = ai.scenarios?.chat
    const provider = (ai.providers ?? []).find((p) => p.id === chat?.providerId)
    baseURL ||= provider?.baseURL ?? ''
    model ||= chat?.model ?? ''
  }
}
if (!baseURL || !model) {
  console.error('[spike] 缺配置：设置 SPIKE_BASE_URL/SPIKE_MODEL，或先在应用内配置 AI 供应商')
  process.exit(1)
}
console.log(`[spike] baseURL=${baseURL}  model=${model}  key=${apiKey ? '已提供' : '无'}`)

const chatModel = createOpenAICompatible({ name: 'spike', baseURL, apiKey }).chatModel(model)

const counts = { textDelta: 0, reasoningDelta: 0, toolCall: 0, toolResult: 0 }
const otherTypes = {}
const reasoningSamples = []
let textDeltaAfterToolResult = 0
let sawToolResult = false
let sawFinish = false
let streamError = null
const t0 = Date.now()
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`

// 90s 总看门狗：防止流挂死让脚本卡住
const abort = new AbortController()
const watchdog = setTimeout(() => abort.abort(new Error('spike 总超时 90s')), 90_000)

const result = streamText({
  model: chatModel,
  abortSignal: abort.signal,
  system: '你是工具调用链路的测试助手，回答保持一句话。',
  prompt: '请先调用 approve_probe 工具（city 填 Hangzhou），拿到工具结果后用一句话总结这次测试。',
  tools: {
    approve_probe: tool({
      description: '模拟一次需要人工审批的探测：挂起 12 秒后返回结果',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        console.log(`[spike] 工具开始挂起 12s（t+${ts()}）city=${city}`)
        await new Promise((r) => setTimeout(r, 12_000))
        return '审批通过：探测完成'
      }
    })
  },
  stopWhen: stepCountIs(4)
})

for await (const part of result.fullStream) {
  switch (part.type) {
    case 'text-delta':
      counts.textDelta++
      if (sawToolResult) textDeltaAfterToolResult++
      break
    case 'reasoning-delta':
    case 'reasoning':
      counts.reasoningDelta++
      if (reasoningSamples.length < 2) reasoningSamples.push(String(part.text ?? '').slice(0, 60))
      break
    case 'tool-call':
      counts.toolCall++
      break
    case 'tool-result':
      counts.toolResult++
      sawToolResult = true
      console.log(`[spike] 工具返回（t+${ts()}）`)
      break
    case 'finish':
      sawFinish = true
      console.log(`[spike] finish（t+${ts()}）finishReason=${part.finishReason}`)
      break
    case 'error':
      streamError = part.error
      console.error(`[spike] 流内错误（t+${ts()}）:`, String(part.error).slice(0, 300))
      break
    default:
      otherTypes[part.type] = (otherTypes[part.type] ?? 0) + 1
  }
}
clearTimeout(watchdog)

const [text, steps] = await Promise.all([result.text, result.steps])
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

console.log('\n===== spike 结果 =====')
console.log(`总耗时 ${elapsed}s`)
console.log(`事件计数: ${JSON.stringify({ ...counts, other: otherTypes })}`)
console.log(`reasoning 样本: ${JSON.stringify(reasoningSamples)}`)
console.log(`最终文本: ${text?.trim().slice(0, 120) || '(空)'}`)
console.log(`步数: ${steps?.length ?? 0}`)

const checks = [
  {
    name: '①多步工具循环',
    pass: (steps?.length ?? 0) >= 2 && counts.toolCall > 0
  },
  {
    name: '②审批挂起 12s 流不断',
    pass: sawFinish && counts.toolResult > 0 && textDeltaAfterToolResult > 0 && !streamError
  },
  {
    name: '③thinking 增量透传',
    pass: counts.reasoningDelta > 0,
    note: '为 0 时可能是该模型/供应商不吐思维链，换 reasoning 模型（如 DeepSeek-R1 类）重测'
  }
]
let allPass = true
for (const c of checks) {
  if (!c.pass) allPass = false
  console.log(`${c.pass ? '✅' : '⚠️ '} ${c.name}${c.note && !c.pass ? ` — ${c.note}` : ''}`)
}
if (streamError) allPass = false
console.log(allPass ? '\n✅ spike 全部通过' : '\n⚠️ 存在待确认项，见上')
process.exit(0)
