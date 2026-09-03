// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ActionConfirmDialog,
  InputPromptDialog,
  UploadDestinationDialog
} from '../src/renderer/src/components/sftp/SftpDialogs'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

it('resets the input on reopening while preserving edits during rerenders', () => {
  const props = {
    title: 'Rename',
    confirmTitle: 'Confirm',
    initial: 'first',
    open: true,
    onConfirm: vi.fn(),
    onCancel: vi.fn()
  }
  const view = render(<InputPromptDialog {...props} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edited' } })
  view.rerender(<InputPromptDialog {...props} />)
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('edited')
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(props.onConfirm).toHaveBeenCalledWith('edited')
  view.rerender(<InputPromptDialog {...props} open={false} />)
  view.rerender(<InputPromptDialog {...props} />)
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('first')
  view.rerender(<InputPromptDialog {...props} initial="second" />)
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('second')
})

it('updates the upload destination only when its supplied path changes', () => {
  const props = { summary: 'file.txt', destPath: '/first', onConfirm: vi.fn(), onCancel: vi.fn() }
  const view = render(<UploadDestinationDialog {...props} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '/edited' } })
  view.rerender(<UploadDestinationDialog {...props} summary="another.txt" />)
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('/edited')
  view.rerender(<UploadDestinationDialog {...props} destPath="/second" />)
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('/second')
})

it('preserves confirmation text DOM nodes and sensitive-path styling across rerenders', () => {
  const props = {
    prompt: {
      action: 'delete' as const,
      entries: [],
      subject: '/etc',
      detailPaths: ['/etc'],
      hits: [{ path: '/etc', label: '/etc' }]
    },
    onConfirm: vi.fn(),
    onCancel: vi.fn()
  }
  const view = render(<ActionConfirmDialog {...props} />)
  const path = screen.getByText('/etc')
  expect(path.className).toContain('font-semibold text-danger')
  view.rerender(<ActionConfirmDialog {...props} />)
  expect(screen.getByText('/etc')).toBe(path)
})
