import { RevealRow } from '@/components/chrome/RevealRow'
import { TabChip, TabScrollArea } from '@/components/chrome/TabChip'
import { CloseDocumentsDialog } from '@/components/editor/CloseDocumentsDialog'
import { useResizePreview } from '@/lib/useResizePreview'
import { cn } from '@/lib/utils'
import { useSessionStore, type HostWorkspaceMirror, type RemoteFileDoc } from '@/stores/session'
import { FileText } from 'lucide-react'
import { Suspense, lazy, useState } from 'react'
import { useTranslation } from 'react-i18next'
/** monaco 核心 ~4MB：首个文件标签页出现时才加载（之后常驻，实例不销毁） */
const RemoteEditorView = lazy(() =>
  import('@/components/editor/RemoteEditorView').then((m) => ({ default: m.RemoteEditorView }))
)

export function HostFilesPane({
  host,
  editorH,
  maxEditorH,
  previewH,
  heightResize
}: {
  host: HostWorkspaceMirror
  editorH: number | null
  maxEditorH: number
  previewH: number | null
  heightResize: ReturnType<typeof useResizePreview>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [pendingCloseFile, setPendingCloseFile] = useState<RemoteFileDoc | null>(null)
  const saveFile = useSessionStore((s) => s.saveFile)
  const reloadFile = useSessionStore((s) => s.reloadFile)
  const closeFile = useSessionStore((s) => s.closeFile)
  const focusFile = useSessionStore((s) => s.focusFile)
  const setFileText = useSessionStore((s) => s.setFileText)
  /** 上区显示的文件（focusFileId 兜底到最后一个，保证编辑区总有可见内容） */
  const activeFileId = host.focusFileId ?? host.files[host.files.length - 1]?.id ?? null

  return (
    <>
      <RevealRow
        open={host.files.length > 0}
        className={
          editorH === null
            ? cn(
                'min-h-0 basis-0 transition-[flex-grow,grid-template-rows] duration-200 ease-out',
                host.files.length > 0 ? 'grow' : 'grow-0'
              )
            : undefined
        }
      >
        <>
          <div
            className={cn('relative min-h-0 bg-sidebar', editorH === null ? 'flex-1' : 'shrink-0')}
            style={editorH !== null ? { height: Math.min(editorH, maxEditorH) } : undefined}
          >
            {host.files.map((f) => (
              <div
                key={f.id}
                inert={activeFileId !== f.id}
                className={cn(
                  'absolute inset-0',
                  activeFileId === f.id ? 'z-10' : 'pointer-events-none opacity-0'
                )}
              >
                <Suspense fallback={null}>
                  <RemoteEditorView
                    doc={f}
                    tabs={
                      <TabScrollArea>
                        {host.files.map((file) => (
                          <TabChip
                            key={file.id}
                            title={file.text !== file.saved ? `${file.name} •` : file.name}
                            icon={FileText}
                            selected={activeFileId === file.id}
                            accentBorder={file.text !== file.saved}
                            showClose
                            onClick={() => focusFile(host.id, file.id)}
                            onClose={() => {
                              if (file.text !== file.saved || file.saving) setPendingCloseFile(file)
                              else closeFile(host.id, file.id)
                            }}
                          />
                        ))}
                      </TabScrollArea>
                    }
                    onText={(text) => setFileText(host.id, f.id, text)}
                    onSave={() => saveFile(host.id, f.id)}
                    onReload={() => reloadFile(host.id, f.id)}
                    onEncoding={(encoding) => reloadFile(host.id, f.id, encoding)}
                    onDownload={() =>
                      window.aterm.sftp.download(host.id, {
                        name: f.name,
                        path: f.path,
                        isDir: false,
                        isLink: false,
                        size: f.size,
                        permissions: null,
                        uid: null,
                        gid: null,
                        accessed: null,
                        modified: null,
                        longname: '',
                        linkTarget: null
                      })
                    }
                  />
                </Suspense>
              </div>
            ))}
          </div>
          {/* 竖向 splitter：拖拽调编辑区高度（松手持久化；拖拽中 accent 提示） */}
          <div
            className={cn(
              'h-px shrink-0 cursor-row-resize touch-none',
              previewH !== null ? 'bg-at-accent/35' : 'bg-line'
            )}
            {...heightResize.handleProps}
          />
        </>
      </RevealRow>
      {/* 关闭未保存文件确认 */}
      {pendingCloseFile && (
        <CloseDocumentsDialog
          documents={[
            { hostId: host.id, fileId: pendingCloseFile.id, name: pendingCloseFile.path }
          ]}
          message={t('session.closeFileMessage', { name: pendingCloseFile.name })}
          onCancel={() => setPendingCloseFile(null)}
          onClose={() => {
            closeFile(host.id, pendingCloseFile.id)
            setPendingCloseFile(null)
          }}
        />
      )}
    </>
  )
}
