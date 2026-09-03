// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectionSessionsDetail } from '../src/renderer/src/components/connection/ConnectionSessionsDetail'
import type { SshConnectionSession } from '../src/shared/types'
import { useSessionStore } from '../src/renderer/src/stores/session'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it('requires confirmation and closes only selected transport IDs', async () => {
  const closeConnections = vi.fn(async () => ({ userClosed: false }))
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: { hosts: { closeConnections } }
  })
  const detach = vi.spyOn(useSessionStore.getState(), 'detachHost')
  const items: SshConnectionSession[] = ['user', 'agent', 'agent'].map((owner, i) => ({
    hostId: 'h',
    connectionId: `id-${i}`,
    owner: owner as 'user' | 'agent',
    phase: 'connected',
    since: 1,
    shellCount: 1
  }))
  render(<ConnectionSessionsDetail hostId="h" name="Host" items={items} onToast={() => {}} />)
  expect(
    (screen.getByRole('button', { name: 'conn.live.closeSelected' }) as HTMLButtonElement).disabled
  ).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'id-1' }))
  fireEvent.click(screen.getByRole('button', { name: 'conn.live.closeSelected' }))
  expect(closeConnections).not.toHaveBeenCalled()
  const confirm = screen
    .getAllByRole('button', { name: 'common.close' })
    .find((button) => button.closest('[role="dialog"]') && !button.hasAttribute('data-slot'))!
  fireEvent.click(confirm)
  await waitFor(() => expect(closeConnections).toHaveBeenCalledWith('h', ['id-1']))
  expect(detach).not.toHaveBeenCalled()
})
