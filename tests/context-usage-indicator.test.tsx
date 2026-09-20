// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ContextUsageIndicator } from '../src/renderer/src/components/ai/ContextUsageIndicator'
import type { AiContextUsage } from '../src/shared/types'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

it('区分估算、供应商输入量和压缩状态，切换模型/窗口后不显示旧统计', () => {
  const usage: AiContextUsage = {
    modelKey: 'a',
    contextWindow: 32768,
    inputTokens: 8192,
    source: 'estimate',
    phase: 'compressing'
  }
  const view = render(<ContextUsageIndicator usage={usage} modelKey="a" contextWindow={32768} />)
  expect(screen.getByText('≈ 8.2K / 32.8K · 25%')).toBeTruthy()
  expect(screen.getByText('ai.contextCompressing')).toBeTruthy()
  expect(screen.getByTitle('ai.contextUsageEstimate')).toBeTruthy()
  view.rerender(
    <ContextUsageIndicator
      usage={{ ...usage, source: 'provider', phase: 'ready', inputTokens: 4096 }}
      modelKey="a"
      contextWindow={32768}
    />
  )
  expect(screen.getByText('4.1K / 32.8K · 13%')).toBeTruthy()
  expect(screen.getByTitle('ai.contextUsageReported')).toBeTruthy()
  expect(screen.queryByText('ai.contextCompressing')).toBeNull()
  view.rerender(<ContextUsageIndicator usage={usage} modelKey="b" contextWindow={32768} />)
  expect(screen.getByText('— / 32.8K')).toBeTruthy()
  view.rerender(<ContextUsageIndicator usage={usage} modelKey="a" contextWindow={1048576} />)
  expect(screen.getByText('— / 1M')).toBeTruthy()
})
