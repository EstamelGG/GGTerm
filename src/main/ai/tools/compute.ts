import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineTool } from './shared'
import { intentSchema, type AnyTool } from './shared'

/**
 * 宽松 schema：runtime 发现工具要求 schema 根是对象，且不支持根 oneOf/discriminatedUnion
 * （会静默丢工具）。所以这里全可选，具体动作的必填校验在 handler 用 discriminatedUnion 做。
 */
const computeParameters = z.object({
  action: z.enum(['hash', 'base64', 'hex', 'url', 'base_convert']),
  description: intentSchema,
  algo: z
    .enum(['md5', 'sha1', 'sha256', 'sha384', 'sha512'])
    .optional()
    .describe('Hash algorithm (hash action)'),
  op: z.enum(['encode', 'decode']).optional().describe('encode or decode (base64/hex/url actions)'),
  data: z.string().optional().describe('Text to hash / encode / decode'),
  value: z.string().optional().describe('Integer string to convert (base_convert)'),
  fromBase: z.number().int().min(2).max(16).optional().describe('Source base 2..16 (base_convert)'),
  toBase: z.number().int().min(2).max(16).optional().describe('Target base 2..16 (base_convert)')
})

const computeRequest = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('hash'),
    algo: z.enum(['md5', 'sha1', 'sha256', 'sha384', 'sha512']),
    data: z.string()
  }),
  z.object({ action: z.literal('base64'), op: z.enum(['encode', 'decode']), data: z.string() }),
  z.object({ action: z.literal('hex'), op: z.enum(['encode', 'decode']), data: z.string() }),
  z.object({ action: z.literal('url'), op: z.enum(['encode', 'decode']), data: z.string() }),
  z.object({
    action: z.literal('base_convert'),
    value: z.string(),
    fromBase: z.number().int().min(2).max(16),
    toBase: z.number().int().min(2).max(16)
  })
])

/** 本机纯计算域：哈希 / 文本编码 / 进制转换（无宿主、无副作用、走 default 直行） */
export const computeTools: AnyTool[] = [
  defineTool('compute', {
    description:
      'Local pure-text computation (no host, no shell). Hash (md5/sha1/sha256/sha384/sha512 → hex digest), base64/hex/url encode or decode, and base_convert (integer string between bases 2..16). All inputs are UTF-8 text strings; this tool does not read or hash files.',
    parameters: computeParameters,
    handler: async (input) => {
      const args = computeRequest.parse(input)
      if (args.action === 'hash') {
        const digest = createHash(args.algo).update(args.data, 'utf8').digest('hex')
        return { algo: args.algo, digest }
      }
      if (args.action === 'base_convert') {
        const n = Number.parseInt(args.value, args.fromBase)
        if (Number.isNaN(n))
          throw new Error(`"${args.value}" is not a valid base-${args.fromBase} integer`)
        return {
          value: args.value,
          fromBase: args.fromBase,
          toBase: args.toBase,
          result: n.toString(args.toBase)
        }
      }
      const encode = args.op === 'encode'
      if (args.action === 'base64') {
        return {
          result: encode
            ? Buffer.from(args.data, 'utf8').toString('base64')
            : Buffer.from(args.data, 'base64').toString('utf8')
        }
      }
      if (args.action === 'hex') {
        return {
          result: encode
            ? Buffer.from(args.data, 'utf8').toString('hex')
            : Buffer.from(args.data, 'hex').toString('utf8')
        }
      }
      return {
        result: encode ? encodeURIComponent(args.data) : decodeURIComponent(args.data)
      }
    }
  })
]
