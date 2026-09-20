// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ModelContextSettings } from '../src/renderer/src/components/ai/ModelContextSettings'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

it('上下文窗口支持 1M，拒绝无效范围，并可关闭自动压缩', () => {
  const onChange = vi.fn()
  render(
    <ModelContextSettings
      value={{ contextWindow: 32_768, autoCompress: true }}
      onChange={onChange}
    />
  )
  const input = screen.getByRole('textbox', { name: 'ai.contextWindow' })
  fireEvent.change(input, { target: { value: '1048576' } })
  expect(onChange).toHaveBeenLastCalledWith({ contextWindow: 1_048_576, autoCompress: true })
  onChange.mockClear()
  fireEvent.change(input, { target: { value: '1048577' } })
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getByText('ai.contextWindowInvalid')).toBeTruthy()
  fireEvent.click(screen.getByRole('switch', { name: 'ai.autoCompress' }))
  expect(onChange).toHaveBeenLastCalledWith({ contextWindow: 32_768, autoCompress: false })
})
