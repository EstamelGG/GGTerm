const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CopilotClient, ToolSet } = require('@github/copilot-sdk')
const http = require('node:http')

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aterm-execution-sdk-'))
  const bundle = path.resolve('node_modules/.cache/execution-sdk-tool.cjs')
  require('esbuild').buildSync({
    entryPoints: ['src/main/ai/executeTool.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    logLevel: 'silent'
  })
  const { executeTool } = require(bundle)
  let offeredToProvider = false
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const payload = JSON.parse(body)
      offeredToProvider ||=
        payload.tools?.some((tool) => (tool.function?.name ?? tool.name) === 'execute') ?? false
      const chunk = {
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'fixture complete' },
            finish_reason: 'stop'
          }
        ]
      }
      if (payload.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            ...chunk,
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'fixture complete' },
                finish_reason: 'stop'
              }
            ]
          })
        )
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const provider = {
    type: 'openai',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'fixture'
  }
  const client = new CopilotClient({ mode: 'empty', baseDirectory: root, logLevel: 'error' })
  const timer = setTimeout(() => {
    console.error('SDK tool validation timed out')
    process.exit(1)
  }, 20000)
  try {
    await client.start()
    const session = await client.createSession({
      model: 'fixture-model',
      provider,
      tools: [executeTool],
      availableTools: new ToolSet().addCustom('*'),
      onPermissionRequest: async () => ({ kind: 'approve-once' })
    })
    session.on('session.error', (event) => console.error(event.data))
    await session.rpc.tools.initializeAndValidate()
    const metadata = await session.rpc.tools.getCurrentMetadata()
    assert(
      metadata.tools?.some((tool) => tool.name === 'execute'),
      'execute must be offered by the real runtime'
    )
    const result = await session.rpc.tools.execute({
      name: 'execute',
      arguments: { action: 'list' }
    })
    assert.equal(result.resultType, 'success')
    assert.equal(result.textResultForLlm, '[]')
    await session.sendAndWait({ prompt: 'Reply with fixture complete.' }, 10000)
    assert(offeredToProvider, 'execute must reach the provider request, not just the registry')
    const id = session.sessionId
    await session.disconnect()
    const restored = await client.resumeSession(id, {
      model: 'fixture-model',
      provider,
      tools: [executeTool],
      availableTools: new ToolSet().addCustom('*'),
      onPermissionRequest: async () => ({ kind: 'approve-once' })
    })
    await restored.rpc.tools.initializeAndValidate()
    assert(
      (await restored.rpc.tools.getCurrentMetadata()).tools?.some((tool) => tool.name === 'execute')
    )
    await restored.disconnect()
    console.log(
      JSON.stringify({
        status: 'passed',
        checks: [
          'runtime offers execute',
          'native tool invocation succeeds',
          'provider request contains execute',
          'resumed session offers execute'
        ]
      })
    )
  } finally {
    clearTimeout(timer)
    await client.stop()
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
