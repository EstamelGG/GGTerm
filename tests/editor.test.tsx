// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  useSessionStore,
  type HostWorkspaceMirror,
  type RemoteFileDoc
} from '../src/renderer/src/stores/session'
import { CloseDocumentsDialog } from '../src/renderer/src/components/editor/CloseDocumentsDialog'
import { RemoteEditorView } from '../src/renderer/src/components/editor/RemoteEditorView'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@monaco-editor/react', () => ({ default: () => <div data-testid="monaco" /> }))
vi.mock('../src/renderer/src/components/editor/monacoSetup', () => ({
  monaco: { languages: { getLanguages: () => [] } }
}))

const writeText = vi.fn()
const readForEdit = vi.fn()
const doc: RemoteFileDoc = {
  id: 'doc',
  name: 'settings',
  path: '/settings',
  size: 10,
  text: 'changed',
  saved: 'original',
  loading: false,
  saving: false,
  error: null,
  encoding: 'gb18030',
  encodingMode: 'auto',
  bom: false,
  confidence: 100,
  readOnly: false
}
beforeEach(() => {
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: { sftp: { writeText, readForEdit } }
  })
  writeText.mockReset()
  readForEdit.mockReset()
  useSessionStore.setState({ hosts: [{ id: 'host', files: [{ ...doc }] } as HostWorkspaceMirror] })
})
afterEach(cleanup)

it('keeps the document dirty and reports save failure without closing', async () => {
  writeText.mockRejectedValue(new Error('Permission denied'))
  const close = vi.fn()
  render(
    <CloseDocumentsDialog
      documents={[{ hostId: 'host', fileId: 'doc', name: '/settings' }]}
      message="Close?"
      onClose={close}
      onCancel={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'session.saveClose' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Permission denied'))
  expect(close).not.toHaveBeenCalled()
  expect(useSessionStore.getState().hosts[0].files[0].saved).toBe('original')
})

it('waits for successful saves and uses the detected encoding', async () => {
  let finish!: () => void
  writeText.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const close = vi.fn()
  render(
    <CloseDocumentsDialog
      documents={[{ hostId: 'host', fileId: 'doc', name: '/settings' }]}
      message="Close?"
      onClose={close}
      onCancel={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'session.saveClose' }))
  expect(close).not.toHaveBeenCalled()
  expect(writeText).toHaveBeenCalledWith('host', '/settings', 'changed', 'gb18030', false)
  finish()
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(useSessionStore.getState().hosts[0].files[0].saved).toBe('changed')
})

it('discards only after explicit choice', () => {
  const close = vi.fn()
  render(
    <CloseDocumentsDialog
      documents={[{ hostId: 'host', fileId: 'doc', name: '/settings' }]}
      message="Close?"
      onClose={close}
      onCancel={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'session.discardClose' }))
  expect(close).toHaveBeenCalledOnce()
  expect(writeText).not.toHaveBeenCalled()
})

it('shows errors even when the editor still has unsaved changes', () => {
  render(
    <RemoteEditorView
      doc={{ ...doc, error: 'Permission denied' }}
      onText={vi.fn()}
      onSave={vi.fn()}
      onReload={vi.fn()}
      onEncoding={vi.fn()}
      onDownload={vi.fn()}
    />
  )
  expect(screen.getByRole('alert').textContent).toBe('Permission denied')
  expect(screen.getByText('editor.unsaved')).toBeTruthy()
  expect(screen.getByRole('combobox', { name: 'editor.encoding' })).toBeTruthy()
})

it('blocks saving a lossy/binary or failed initial read', async () => {
  useSessionStore.setState({
    hosts: [{ id: 'host', files: [{ ...doc, readOnly: true }] } as HostWorkspaceMirror]
  })
  expect(await useSessionStore.getState().saveFile('host', 'doc')).toBe(false)
  expect(writeText).not.toHaveBeenCalled()
})

it('preserves the old buffer when reopening with another encoding fails', async () => {
  readForEdit.mockRejectedValue(new Error('Disconnected'))
  useSessionStore.getState().reloadFile('host', 'doc', 'big5')
  await waitFor(() => expect(useSessionStore.getState().hosts[0].files[0].loading).toBe(false))
  const current = useSessionStore.getState().hosts[0].files[0]
  expect(current.text).toBe('changed')
  expect(current.encoding).toBe('gb18030')
  expect(current.error).toBe('Disconnected')
})
