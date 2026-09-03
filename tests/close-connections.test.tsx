// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CloseDocumentsDialog } from '../src/renderer/src/components/editor/CloseDocumentsDialog'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)
it('checks only the user connection by default and returns only selected Agent IDs', async () => {
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: {
      hosts: {
        connectionSessions: async () => [
          { hostId: 'host', owner: 'user', connectionId: 'user-id' },
          { hostId: 'host', owner: 'agent', connectionId: 'agent-one' },
          { hostId: 'host', owner: 'agent', connectionId: 'agent-two' }
        ]
      }
    }
  })
  const close = vi.fn()
  render(
    <CloseDocumentsDialog
      documents={[]}
      hostIds={['host']}
      message="Close"
      onCancel={() => {}}
      onClose={close}
    />
  )
  await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(3))
  const inputs = screen.getAllByRole('checkbox') as HTMLInputElement[]
  expect(inputs.map((input) => input.checked)).toEqual([true, false, false])
  expect(inputs[0].disabled).toBe(true)
  fireEvent.click(inputs[2])
  fireEvent.click(
    screen
      .getAllByRole('button', { name: 'common.close' })
      .find((button) => !button.hasAttribute('data-slot'))!
  )
  expect(close).toHaveBeenCalledWith(['agent-two'])
})
