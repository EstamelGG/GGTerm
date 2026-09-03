// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/components/sftp/SftpTreeView', () => ({ INTERNAL_MIME: 'test/files' }))
vi.mock('../src/renderer/src/terminal/theme', () => ({
  loadTerminalFonts: () => new Promise(() => {})
}))
vi.mock('../src/renderer/src/terminal/registry', () => ({
  attachTerminal: vi.fn(),
  detachTerminal: vi.fn(),
  fitTerminal: vi.fn(),
  refreshTerminalFonts: vi.fn(),
  focusTerminal: vi.fn(),
  pasteTerminal: vi.fn(),
  terminalSelection: vi.fn(),
  findTerminal: vi.fn(() => true)
}))
import { TerminalPane } from '../src/renderer/src/components/terminal/TerminalPane'
import {
  pasteTerminal,
  terminalSelection,
  findTerminal
} from '../src/renderer/src/terminal/registry'
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('right-click copies selection, otherwise pastes without reading the clipboard for copy', async () => {
  const readText = vi.fn(async () => 'clipboard data')
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText, writeText }
  })
  const { container } = render(<TerminalPane instanceKey="active" />)
  vi.mocked(terminalSelection).mockReturnValue('selected output')
  fireEvent.contextMenu(container.firstChild!)
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('selected output'))
  expect(readText).not.toHaveBeenCalled()
  expect(pasteTerminal).not.toHaveBeenCalled()
  vi.mocked(terminalSelection).mockReturnValue('')
  fireEvent.contextMenu(container.firstChild!)
  await waitFor(() => expect(pasteTerminal).toHaveBeenCalledWith('active', 'clipboard data'))
})

it('opens search with Ctrl+Shift+F and handles next, previous and escape locally', () => {
  Object.defineProperty(window, 'aterm', {
    configurable: true,
    value: { window: { platform: 'win32' } }
  })
  const { container } = render(<TerminalPane instanceKey="active" />)
  fireEvent.keyDown(container.firstChild!, { key: 'f', ctrlKey: true })
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.keyDown(container.firstChild!, { key: 'f', ctrlKey: true, shiftKey: true })
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'needle' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(findTerminal).toHaveBeenLastCalledWith('active', 'needle', false)
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  expect(findTerminal).toHaveBeenLastCalledWith('active', 'needle', true)
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByRole('textbox')).toBeNull()
})
