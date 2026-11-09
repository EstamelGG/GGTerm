import { beforeEach, expect, it, vi } from 'vitest'
const data = vi.hoisted(() => ({ ai: {} as unknown }))
vi.mock('electron-store', () => ({
  default: class {
    get(key: string): unknown {
      return key === 'ai' ? data.ai : undefined
    }
  }
}))
import { getPreferences } from '../src/main/data/prefs'
import { parseInput, preferencesSchema } from '../src/main/ipc/validation'
beforeEach(() => {
  data.ai = {}
})

it('keeps the legacy flat model and submodel attached to the default provider', () => {
  data.ai = {
    provider: 'Legacy',
    baseURL: 'http://localhost:1234',
    model: 'chat',
    subModel: 'judge'
  }
  const ai = getPreferences().ai
  expect(ai.providers).toEqual([
    { id: 'default', label: 'Legacy', baseURL: 'http://localhost:1234' }
  ])
  expect(ai.scenarios).toEqual({
    chat: { providerId: 'default', model: 'chat' },
    judge: { providerId: 'default', model: 'judge' }
  })
  expect(parseInput(preferencesSchema, { ai })).toEqual({ ai })
})
it('retains profile identifiers and active selection when migrating multiple legacy profiles', () => {
  data.ai = {
    profiles: [
      { id: 'one', label: 'First', baseURL: '', model: 'a' },
      { id: 'two', label: 'Second', baseURL: '', model: 'b' }
    ],
    activeProfileId: 'two'
  }
  const ai = getPreferences().ai
  expect(ai.providers.map((provider) => provider.id)).toEqual(['one', 'two'])
  expect(ai.scenarios.chat).toEqual({ providerId: 'two', model: 'b' })
  expect(parseInput(preferencesSchema, { ai })).toEqual({ ai })
})
