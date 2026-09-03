import { useEffect, useMemo, useRef, useState } from 'react'
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react'
import { Download, Loader2, Redo2, RotateCw, Save, Search, Undo2, WrapText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconButton } from '@/components/ui/IconButton'
import { DialogShell } from '@/components/ui/DialogShell'
import { Button } from '@/components/form/Buttons'
import { terminalFontFamily } from '@/terminal/theme'
import type { RemoteFileDoc } from '@/stores/session'
import { monaco } from './monacoSetup'
import { observeSettledResize } from '@/lib/observeSettledResize'
import { FILE_ENCODINGS, type EncodingMode } from '@shared/encoding'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

/**
 * 对照 ATerminal-Swift Views/Editor/RemoteEditorView.swift：
 * Monaco 编辑器 + aTerminalDark 主题 + 状态栏（dirty/saving/error/saved）
 * + ⌘S 保存 / Esc 收起选区；内容 ready 才挂载（避免空编辑器布局）。
 */

const BG = '#171A1C'

/** 对照 EditorTheme.aTerminalDark 的 token 色 */
function defineTheme(): void {
  monaco.editor.defineTheme('ggterm-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'DCDEE1' },
      { token: 'keyword', foreground: 'FF7AB3', fontStyle: 'bold' },
      { token: 'keyword.json', foreground: 'DCDEE1' },
      { token: 'comment', foreground: '808C99' },
      { token: 'string', foreground: 'FF8271' },
      { token: 'string.escape', foreground: 'D9CA7D' },
      { token: 'number', foreground: 'D9CA7D' },
      { token: 'type', foreground: '6BDEFF' },
      { token: 'type.identifier', foreground: '6BDEFF' },
      { token: 'identifier', foreground: 'DCDEE1' },
      { token: 'function', foreground: '78C2B3' },
      { token: 'variable', foreground: '4FB0CC' },
      { token: 'variable.predefined', foreground: 'B382EB' },
      { token: 'variable.parameter', foreground: '4FB0CC' },
      { token: 'constant', foreground: 'B382EB' },
      { token: 'attribute.name', foreground: 'CC9769' },
      { token: 'attribute.value', foreground: 'FF8271' },
      { token: 'delimiter', foreground: '808C99' },
      { token: 'tag', foreground: 'FF7AB3' },
      { token: 'metatag', foreground: '78C2B3' },
      { token: 'key', foreground: 'CC9769' }
    ],
    colors: {
      'editor.background': BG,
      'editor.foreground': '#DCDEE1',
      'editorLineNumber.foreground': '#565F68',
      'editorLineNumber.activeForeground': '#8A959E',
      'editorCursor.foreground': '#4DD980',
      'editor.selectionBackground': '#FFFFFF40',
      'editor.lineHighlightBackground': '#212428',
      'editorIndentGuide.background': '#24272B',
      'editorIndentGuide.activeBackground': '#34383D',
      'editorWhitespace.foreground': '#55616B',
      'minimap.background': '#14171A',
      'scrollbarSlider.background': '#FFFFFF14',
      'scrollbarSlider.hoverBackground': '#FFFFFF24',
      'scrollbarSlider.activeBackground': '#FFFFFF33',
      'editorGutter.background': BG,
      'editorOverviewRuler.border': '#00000000'
    }
  })
}

const beforeMount: BeforeMount = () => {
  defineTheme()
}

/** 扩展名 → Monaco 语言 id（对照 CodeLanguage.detectLanguageFrom） */
function detectLanguage(path: string): string {
  const lower = path.toLowerCase()
  const hit = monaco.languages
    .getLanguages()
    .find((l) => l.extensions?.some((ext) => lower.endsWith(ext)))
  return hit?.id ?? 'plaintext'
}

export function RemoteEditorView({
  doc,
  onText,
  onSave,
  onReload,
  onEncoding,
  onDownload
}: {
  doc: RemoteFileDoc
  onText: (text: string) => void
  onSave: () => void
  /** 重新拉取远端内容（dirty 确认已在本组件内处理） */
  onReload: () => void
  onEncoding: (encoding: EncodingMode) => void
  onDownload: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const language = useMemo(() => detectLanguage(doc.path), [doc.path])
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [pendingReload, setPendingReload] = useState(false)
  const [wordWrap, setWordWrap] = useState(false)
  const [pendingEncoding, setPendingEncoding] = useState<EncodingMode | null>(null)
  const saveRef = useRef(onSave)
  useEffect(() => {
    saveRef.current = onSave
  }, [onSave])

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    const container = editor.getContainerDomNode()
    const layout = (): void => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        editor.layout({ width: container.clientWidth, height: container.clientHeight })
      }
    }
    const stopResize = observeSettledResize(container, layout)
    editor.onDidDispose(stopResize)
    layout()
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())
    editor.addCommand(monaco.KeyCode.Escape, () => {
      const pos = editor.getPosition()
      if (pos) {
        editor.setSelection(
          new monaco.Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column)
        )
      }
    })
  }

  const dirty = doc.text !== doc.saved

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ backgroundColor: BG }}>
      {/* 工具行（tab 栏下方）：全部桥接 Monaco 原生命令 / 既有链路 */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line bg-sidebar px-2">
        {/* 第一组：撤销/重做 */}
        <IconButton
          variant="toolbar"
          icon={Undo2}
          frame={22}
          title={t('editor.undo')}
          disabled={doc.loading}
          onClick={() => editorRef.current?.trigger('api', 'undo', null)}
        />
        <IconButton
          variant="toolbar"
          icon={Redo2}
          frame={22}
          title={t('editor.redo')}
          disabled={doc.loading}
          onClick={() => editorRef.current?.trigger('api', 'redo', null)}
        />
        <div className="mx-1 h-4 w-px bg-line" />
        {/* 第二组：刷新/保存/下载 */}
        <IconButton
          variant="toolbar"
          icon={RotateCw}
          frame={22}
          title={t('editor.reload')}
          disabled={doc.loading || doc.saving}
          onClick={() => (dirty ? setPendingReload(true) : onReload())}
        />
        <IconButton
          variant="toolbar"
          icon={Save}
          frame={22}
          title={t('common.save')}
          disabled={doc.loading || doc.saving || doc.readOnly || !dirty}
          onClick={onSave}
        />
        <IconButton
          variant="toolbar"
          icon={Download}
          frame={22}
          title={t('common.download')}
          disabled={doc.loading || doc.saving}
          onClick={onDownload}
        />
        <div className="mx-1 h-4 w-px bg-line" />
        {/* 第三组：搜索 */}
        <IconButton
          variant="toolbar"
          icon={Search}
          frame={22}
          title={t('editor.find')}
          disabled={doc.loading}
          onClick={() => void editorRef.current?.getAction('actions.find')?.run()}
        />
        <IconButton
          variant="toolbar"
          icon={WrapText}
          frame={22}
          title={t(wordWrap ? 'editor.disableWordWrap' : 'editor.enableWordWrap')}
          aria-label={t('editor.wordWrap')}
          aria-pressed={wordWrap}
          selected={wordWrap}
          onClick={() => setWordWrap((enabled) => !enabled)}
        />
      </div>

      {/* 不加 overflow-hidden：Monaco 浮层（搜索框 tooltip 等）由 ContextView 挂在编辑器容器内、
          会越出编辑器盒上边缘，外层裁剪会把它们截断（工具栏背后"被盖一截"）。
          编辑器内部裁剪由 Monaco 自带 .overflow-guard 负责 */}
      <div className="relative min-h-0 flex-1">
        {!doc.loading && (
          <Editor
            value={doc.text}
            language={language}
            theme="ggterm-dark"
            beforeMount={beforeMount}
            onMount={onMount}
            onChange={(v) => onText(v ?? '')}
            options={{
              readOnly: doc.readOnly || doc.saving,
              fontFamily: terminalFontFamily,
              fontSize: 13,
              minimap: { enabled: true },
              wordWrap: wordWrap ? 'on' : 'off',
              scrollBeyondLastLine: false,
              automaticLayout: false,
              renderLineHighlight: 'line',
              lineNumbers: 'on',
              folding: true,
              glyphMargin: false,
              padding: { top: 0, bottom: 0 },
              overviewRulerBorder: false,
              smoothScrolling: true,
              cursorBlinking: 'blink'
            }}
          />
        )}
        {/* 仅加载期遮挡（内容尚未就绪）；保存期不遮挡，状态栏已有"保存中"提示 */}
        {doc.loading && <div className="absolute inset-0 bg-black/35 backdrop-blur-sm" />}
        {doc.loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin text-info" />
            <span className="text-minor text-fg">{t('editor.loading')}</span>
          </div>
        )}
      </div>

      {/* 对照 statusBar */}
      {doc.error && (
        <p
          role="alert"
          className="max-h-24 shrink-0 overflow-auto whitespace-pre-wrap break-words bg-sidebar px-3 py-2 text-minor text-danger select-text"
        >
          {doc.error}
        </p>
      )}
      <div className="flex min-h-7 shrink-0 flex-wrap items-center gap-2 bg-sidebar px-3 text-caption">
        {doc.saving ? (
          <span className="text-muted">{t('editor.saving')}</span>
        ) : dirty ? (
          <span className="text-warn">{t('editor.unsaved')}</span>
        ) : !doc.loading ? (
          <span className="text-muted">{t(doc.readOnly ? 'editor.readOnly' : 'editor.saved')}</span>
        ) : null}
        <span title={doc.path} className="min-w-0 flex-1 truncate font-mono text-muted">
          {doc.path}
        </span>
        <Select
          value={doc.encodingMode}
          onValueChange={(value) =>
            dirty ? setPendingEncoding(value as EncodingMode) : onEncoding(value as EncodingMode)
          }
        >
          <SelectTrigger
            className="h-6 px-2 text-caption text-muted"
            disabled={doc.loading || doc.saving}
            aria-label={t('editor.encoding')}
            title={t('editor.encodingHint')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">
              {t('editor.autoEncoding', {
                encoding: FILE_ENCODINGS.find((e) => e.id === doc.encoding)?.label ?? doc.encoding
              })}
            </SelectItem>
            {FILE_ENCODINGS.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {doc.encodingMode === 'auto' && doc.confidence < 80 && (
        <p className="shrink-0 bg-sidebar px-3 pb-2 text-caption text-muted">
          {t('editor.encodingUncertain')}
        </p>
      )}

      {/* dirty 状态下刷新的丢弃确认 */}
      <DialogShell
        open={pendingReload || pendingEncoding !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPendingReload(false)
            setPendingEncoding(null)
          }
        }}
        title={t('editor.reloadTitle')}
        width={400}
        footer={
          <>
            <Button
              variant="ghost"
              title={t('common.cancel')}
              onClick={() => {
                setPendingReload(false)
                setPendingEncoding(null)
              }}
            />
            <Button
              title={t('editor.reload')}
              onClick={() => {
                setPendingReload(false)
                if (pendingEncoding !== null) onEncoding(pendingEncoding)
                else onReload()
                setPendingEncoding(null)
              }}
            />
          </>
        }
      >
        <p className="text-body text-muted">{t('editor.reloadMessage', { name: doc.name })}</p>
      </DialogShell>
    </div>
  )
}
