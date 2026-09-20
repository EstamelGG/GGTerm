// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { useAiStore } from '../src/renderer/src/stores/ai'
import { useWorkspaceStore } from '../src/renderer/src/stores/workspace'
import { useSessionStore } from '../src/renderer/src/stores/session'
import { useConnectionsStore } from '../src/renderer/src/stores/connections'
import type { AiUIMessage, HostConnection } from '../src/shared/types'

beforeEach(() => {
  useWorkspaceStore.setState({
    sidebarOpen: false,
    attachments: {},
    fileAttachments: {},
    focusedHostId: null
  })
  useConnectionsStore.setState({
    connections: [
      { id: 'a', name: 'Same name', host: '10.0.0.1', port: 22, username: 'one' },
      { id: 'b', name: 'Same name', host: '10.0.0.2', port: 22, username: 'two' }
    ] as HostConnection[]
  })
})

it('sends references by ID and the latest focused host, keeping other conversations isolated', async () => {
  const id = crypto.randomUUID()
  const run = vi.fn(async () => {})
  Object.defineProperty(window, 'aterm', { configurable: true, value: { ai: { run } } })
  useAiStore.setState({
    activeId: id,
    sessions: [
      {
        id,
        title: '',
        createdAt: 1,
        updatedAt: 1,
        messages: [],
        loaded: true,
        status: 'ready'
      }
    ]
  })
  const workspace = useWorkspaceStore.getState()
  workspace.attachHost('another-chat', 'b')
  workspace.attachHost(id, 'a')
  workspace.attachHost(id, 'a')
  expect(useWorkspaceStore.getState().attachments[id]).toEqual(['a'])
  expect(useWorkspaceStore.getState().sidebarOpen).toBe(true)
  useSessionStore.getState().setTab({ kind: 'host', id: 'b' })
  useAiStore.getState().send('Check this host')
  await vi.waitFor(() => expect(run).toHaveBeenCalled())
  const message = (run.mock.calls[0] as unknown as [string, AiUIMessage[]])[1].at(-1)!
  expect(message.metadata?.hostReferences).toEqual([
    { id: 'a', name: 'Same name', host: '10.0.0.1', port: 22 }
  ])
  const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
  expect(text).toContain('"focusedHost":{"id":"b"')
  expect(text).toContain(
    'Explicit user targets, referenced hosts and referenced files take precedence'
  )
  expect(useWorkspaceStore.getState().attachments[id]).toEqual([])
  expect(useWorkspaceStore.getState().attachments['another-chat']).toEqual(['b'])
})

it('allows a reference to be removed without affecting the focused host', () => {
  const s = useWorkspaceStore.getState()
  s.focusHost('b')
  s.attachHost('chat', 'a')
  s.removeHost('chat', 'a')
  expect(useWorkspaceStore.getState().attachments.chat).toEqual([])
  expect(useWorkspaceStore.getState().focusedHostId).toBe('b')
})

it('keeps remote paths scoped to their host and conversation and sends file metadata with the request', async () => {
  const id = crypto.randomUUID()
  const run = vi.fn(async () => {})
  Object.defineProperty(window, 'aterm', { configurable: true, value: { ai: { run } } })
  useAiStore.setState({
    activeId: id,
    sessions: [
      { id, title: '', createdAt: 1, updatedAt: 1, messages: [], loaded: true, status: 'ready' }
    ]
  })
  const file = {
    hostId: 'a',
    hostName: 'Host A',
    host: '10.0.0.1',
    port: 22,
    username: 'one',
    path: '/etc/app config.json',
    name: 'app config.json',
    isDir: false
  }
  const otherFile = { ...file, hostId: 'b', hostName: 'Host B', host: '10.0.0.2' }
  const s = useWorkspaceStore.getState()
  s.focusHost('b')
  s.attachFile(id, file)
  s.attachFile(id, file)
  s.attachFile(id, otherFile)
  s.attachFile('other-chat', { ...file, path: '/var/log', name: 'log', isDir: true })
  expect(useWorkspaceStore.getState().fileAttachments[id]).toHaveLength(2)
  s.removeFile(id, 'b', file.path)
  expect(useWorkspaceStore.getState().fileAttachments[id]).toEqual([file])
  expect(useWorkspaceStore.getState().focusedHostId).toBe('b')
  expect(useWorkspaceStore.getState().activePanel).toBe('ai')
  useAiStore.getState().send('Explain this configuration')
  await vi.waitFor(() => expect(run).toHaveBeenCalled())
  const message = (run.mock.calls[0] as unknown as [string, AiUIMessage[]])[1].at(-1)!
  expect(message.metadata?.fileReferences).toEqual([file])
  const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
  expect(text).toContain(JSON.stringify(file))
  expect(text).toContain('Each file belongs to its specified hostId')
  expect(useWorkspaceStore.getState().fileAttachments[id]).toEqual([])
  expect(useWorkspaceStore.getState().fileAttachments['other-chat'][0].isDir).toBe(true)
})
