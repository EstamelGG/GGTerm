// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useWorkspaceIssues } from '../src/renderer/src/stores/workspaceIssues'
import { WorkspaceIssues } from '../src/renderer/src/components/chrome/WorkspaceIssues'
import { errorMessage } from '../src/shared/error'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => {
  cleanup()
  useWorkspaceIssues.setState({ issues: {} })
})
it('normalizes IPC and serialized errors without losing their cause', () => {
  expect(
    errorMessage(new Error("Error invoking remote method 'sftp:read': Error: Permission denied"))
  ).toBe('Permission denied')
  expect(errorMessage({ message: 'Disconnected' })).toBe('Disconnected')
  expect(errorMessage(null)).toBe('Unknown error')
})
it('keeps recovery failures visible, prevents duplicate retries, and clears on recovery', async () => {
  let finish!: () => void
  const retry = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  useWorkspaceIssues.getState().report('restore', new Error('offline'), 'recovery', retry)
  render(<WorkspaceIssues />)
  expect(screen.getByRole('alert').textContent).toContain('offline')
  fireEvent.click(screen.getByText('workspaceErrors.retry'))
  fireEvent.click(screen.getByText('workspaceErrors.retry'))
  expect(retry).toHaveBeenCalledOnce()
  expect((screen.getByText('workspaceErrors.retry') as HTMLButtonElement).disabled).toBe(true)
  finish()
  await waitFor(() =>
    expect((screen.getByText('workspaceErrors.retry') as HTMLButtonElement).disabled).toBe(false)
  )
  fireEvent.click(screen.getByText('workspaceErrors.dismiss'))
  expect(screen.queryByRole('alert')).toBeNull()
})
