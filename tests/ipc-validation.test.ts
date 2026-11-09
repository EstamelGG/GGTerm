import { expect, it } from 'vitest'
import { AI_DEFAULTS } from '../src/shared/ai'
import { parseInput, preferencesSchema, runSchema, keySchema } from '../src/main/ipc/validation'

it.each([
  null,
  [],
  { unknown: true },
  { uiScale: NaN },
  { uiScale: 151 },
  { locale: 'fr' },
  { perfMonitorDisabled: 'false' },
  { ai: { ...AI_DEFAULTS, approvalLevel: 'never' } }
])('rejects malformed preferences before persistence: %j', (input) => {
  expect(() => parseInput(preferencesSchema, input)).toThrow('Invalid IPC input')
})
it('accepts existing preferences and incomplete provider drafts', () => {
  const patch = {
    uiScale: 123,
    ai: { ...AI_DEFAULTS, providers: [{ id: 'draft', label: '', baseURL: '' }] }
  }
  expect(parseInput(preferencesSchema, patch)).toEqual(patch)
})
it('preserves SDK-specific message parts and metadata', () => {
  const input = {
    sessionId: 's',
    turnId: 't',
    messages: [
      {
        id: 'm',
        role: 'assistant',
        metadata: { createdAt: 1 },
        parts: [
          { type: 'tool-read', toolCallId: 'c', state: 'output-available', output: { text: 'ok' } }
        ]
      }
    ]
  }
  expect(parseInput(runSchema, input)).toEqual(input)
  expect(() => parseInput(runSchema, { ...input, messages: [{}] })).toThrow('Invalid IPC input')
})
it('does not echo credential values into validation errors', () => {
  expect(() => parseInput(keySchema, { profileId: '', apiKey: 'private-test-value' })).toThrow(
    'Invalid IPC input: profileId'
  )
})
