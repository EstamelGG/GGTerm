// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ModelManagerPanel } from '../src/renderer/src/components/ai/ModelManagerPanel'
import { usePrefsStore } from '../src/renderer/src/stores/prefs'
import { contextSettingsFor, modelSettingsKey } from '../src/shared/ai'
import type { AppPreferencesData } from '../src/shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key
  })
}))

let saved: AppPreferencesData
const setPrefs = vi.fn(async (patch: Partial<AppPreferencesData>) => {
  saved = { ...saved, ...structuredClone(patch) }
})
const setApiKey = vi.fn(async () => {})
const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
  saved = {
    confirmCloseSession: true,
    accentHex: '#37A563',
    locale: 'auto',
    perfMonitorDisabled: false,
    bgTransparency: 100,
    uiScale: 100,
    terminalFontSize: 12,
    ai: {
      providers: [
        { id: 'p1', label: 'Local A', baseURL: 'http://localhost:1111' },
        { id: 'p2', label: 'Local B', baseURL: 'http://localhost:2222' }
      ],
      scenarios: { chat: { providerId: 'p1', model: 'model-a' } },
      modelCache: { p1: ['model-a', 'model-b'], p2: ['model-a'] },
      approvalLevel: 'default'
    }
  }
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      prefs: { get: async () => structuredClone(saved), set: setPrefs },
      ai: {
        hasApiKey: vi.fn(async () => true),
        setApiKey,
        listModels: vi.fn(async () => ['model-a', 'model-b'])
      }
    }
  })
  usePrefsStore.setState({ data: structuredClone(saved) })
})
afterEach(() => {
  cleanup()
  if (scrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

it('空密钥开关按供应商保存，切换供应商、重新挂载和重新加载偏好后保持状态', async () => {
  const view = render(<ModelManagerPanel />)
  fireEvent.click(screen.getByRole('switch', { name: 'settings.aiNoKey' }))
  expect(saved.ai.providers[0].noKey).toBe(true)
  expect(saved.ai.providers[1].noKey).toBeUndefined()
  expect(
    (screen.getByRole('textbox', { name: 'settings.aiApiKey' }) as HTMLInputElement).disabled
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Local B' }))
  expect(
    screen.getByRole('switch', { name: 'settings.aiNoKey' }).getAttribute('aria-checked')
  ).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: 'Local A' }))
  expect(
    screen.getByRole('switch', { name: 'settings.aiNoKey' }).getAttribute('aria-checked')
  ).toBe('true')
  view.unmount()
  await act(async () => {
    await usePrefsStore.getState().load()
  })
  render(<ModelManagerPanel />)
  expect(
    screen.getByRole('switch', { name: 'settings.aiNoKey' }).getAttribute('aria-checked')
  ).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'settings.aiSaveAndVerify' }))
  await waitFor(() => expect(setApiKey).toHaveBeenCalledWith('p1', ''))
  fireEvent.click(screen.getByRole('switch', { name: 'settings.aiNoKey' }))
  expect(saved.ai.providers[0].noKey).toBe(false)
})

async function chooseModel(name: string): Promise<void> {
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'ai.modelContextModel' }), {
    key: 'ArrowDown'
  })
  const option = await screen.findByRole('option', { name })
  fireEvent.keyDown(option, { key: 'Enter' })
}

it('在供应商下编辑不同模型的窗口，恢复各自设置且不修改当前对话模型', async () => {
  render(<ModelManagerPanel />)
  const size = (): HTMLInputElement =>
    screen.getByRole('textbox', { name: 'ai.contextWindow' }) as HTMLInputElement
  fireEvent.change(size(), { target: { value: '1048576' } })
  await chooseModel('model-b')
  expect(size().value).toBe('32768')
  fireEvent.change(size(), { target: { value: '65536' } })
  await chooseModel('model-a')
  expect(size().value).toBe('1048576')
  expect(saved.ai.scenarios.chat).toEqual({ providerId: 'p1', model: 'model-a' })
  expect(
    saved.ai.modelSettings?.[modelSettingsKey({ providerId: 'p1', model: 'model-b' })]
      ?.contextWindow
  ).toBe(65536)
  fireEvent.click(screen.getByRole('button', { name: 'Local B' }))
  expect(size().value).toBe('32768')
  expect(contextSettingsFor(saved.ai).contextWindow).toBe(1048576)
})
