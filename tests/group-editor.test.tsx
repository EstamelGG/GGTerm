// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { GroupEditor } from '../src/renderer/src/components/connection/GroupEditor'
import { useConnectionsStore } from '../src/renderer/src/stores/connections'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const originalCreate = useConnectionsStore.getState().createGroup
afterEach(() => {
  cleanup()
  useConnectionsStore.setState({ createGroup: originalCreate })
})

it('preserves a failed group draft and only closes after a successful retry', async () => {
  const createGroup = vi
    .fn()
    .mockRejectedValueOnce(new Error('Disk full'))
    .mockResolvedValueOnce({ id: 'new' })
  useConnectionsStore.setState({ createGroup })
  const dismiss = vi.fn()
  render(<GroupEditor payload={{ kind: 'create', parentId: null }} onDismiss={dismiss} />)
  const name = screen.getByRole('textbox', { name: 'conn.groupName' }) as HTMLInputElement
  fireEvent.change(name, { target: { value: 'Lab' } })
  fireEvent.click(screen.getByRole('button', { name: 'common.create' }))
  await screen.findByText('Disk full')
  expect(dismiss).not.toHaveBeenCalled()
  expect(name.value).toBe('Lab')
  fireEvent.click(screen.getByRole('button', { name: 'common.create' }))
  await waitFor(() => expect(dismiss).toHaveBeenCalledOnce())
  expect(createGroup).toHaveBeenCalledTimes(2)
})
