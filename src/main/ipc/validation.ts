import { z } from 'zod'
import { MAX_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW } from '../../shared/ai'
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  UI_SCALE_MAX,
  UI_SCALE_MIN
} from '../../shared/prefs'

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    // Never include input values (credentials or message contents) in errors/logs.
    throw new Error(`Invalid IPC input: ${result.error.issues[0]?.path.join('.') || 'payload'}`)
  }
  return result.data
}

export const idSchema = z.string().refine((value) => value.trim().length > 0)
export const localeSchema = z.enum(['auto', 'zh-CN', 'en'])
const binding = z.object({ providerId: z.string(), model: z.string() }).strict()
const aiConfig = z
  .object({
    providers: z.array(
      z
        .object({
          id: idSchema,
          label: z.string(),
          baseURL: z.string(),
          noKey: z.boolean().optional()
        })
        .strict()
    ),
    scenarios: z
      .object({
        chat: binding.nullable().optional(),
        judge: binding.nullable().optional(),
        title: binding.nullable().optional()
      })
      .strict(),
    modelCache: z.record(z.string(), z.array(z.string())).optional(),
    modelSettings: z
      .record(
        z.string(),
        z
          .object({
            contextWindow: z.number().int().min(MIN_CONTEXT_WINDOW).max(MAX_CONTEXT_WINDOW),
            autoCompress: z.boolean()
          })
          .strict()
      )
      .optional(),
    approvalLevel: z.enum(['strict', 'default', 'relaxed'])
  })
  .strict()

export const preferencesSchema = z
  .object({
    confirmCloseSession: z.boolean(),
    accentHex: z.string().regex(/^#[\da-f]{6}$/i),
    locale: localeSchema,
    perfMonitorDisabled: z.boolean(),
    bgTransparency: z.number().min(0).max(100),
    uiScale: z.number().min(UI_SCALE_MIN).max(UI_SCALE_MAX),
    terminalFontSize: z.number().min(TERMINAL_FONT_SIZE_MIN).max(TERMINAL_FONT_SIZE_MAX),
    localShell: z.string(),
    ai: aiConfig
  })
  .partial()
  .strict()

export const sessionSchema = z.object({ sessionId: idSchema })
export const cancelSchema = sessionSchema.extend({ turnId: idSchema.optional() })
export const runSchema = sessionSchema.extend({
  turnId: idSchema,
  // SDK tool/data parts and metadata remain extensible; validate the envelope here.
  messages: z.array(
    z
      .object({
        id: idSchema,
        role: z.enum(['system', 'user', 'assistant']),
        parts: z.array(z.object({ type: idSchema }).passthrough())
      })
      .passthrough()
  )
})
export const modelSchema = z.object({ providerId: idSchema })
export const keySchema = z.object({ profileId: idSchema, apiKey: z.string() })
export const logSchema = z.object({ category: z.string(), message: z.string() })
