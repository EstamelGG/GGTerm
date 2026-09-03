import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronsDownUp,
  Eye,
  EyeOff,
  Folder,
  FolderPlus,
  Home,
  Loader2,
  RotateCw,
  Upload,
  WifiOff
} from 'lucide-react'
import type { SftpEntry } from '@shared/types'
import { canMove, guardHits, joinPath, normalizePath, parentPath } from '@shared/sftpPath'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/IconButton'
import { ChromeSeparator } from '@/components/chrome/ChromeSeparator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { listedEntries, useSftpStore } from '@/stores/sftp'
import { SftpTreeView, type SftpTreeActions } from './SftpTreeView'
import {
  ActionConfirmDialog,
  InputPromptDialog,
  LargeFileDialog,
  PermissionDialog,
  SftpInfoSheet,
  UploadConflictDialog,
  UploadDestinationDialog,
  type SftpActionPrompt
} from './SftpDialogs'

/**
 * 对照 ATerminal-Swift Views/Sftp/SftpPane.swift：
 * 工具栏 + 路径条 + 树 + 离线遮罩 + 全部确认弹窗状态机。
 * 树状态在 useSftpStore；通道生命周期由挂载 ensureStarted 驱动（不随卸载断开）。
 */

type InputKind = 'mkdir' | 'newFile' | 'rename' | 'moveTo'

interface InputState {
  kind: InputKind
  title: string
  placeholder?: string
  initial: string
  confirmTitle: string
  target?: SftpEntry
  parent?: string
}

interface UploadPromptState {
  localPaths: string[]
  destPath: string
  summary: string
}

/** 编辑器直接打开的大小上限（≥ 此值改为提示下载） */
const OPEN_FILE_LIMIT = 10 * 1024 * 1024

export function SftpPane({
  hostId,
  onToast,
  onOpenTerminal,
  onOpenFile
}: {
  hostId: string
  onToast: (text: string) => void
  onOpenTerminal: (dir: string) => void
  onOpenFile: (entry: SftpEntry) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const pane = useSftpStore((s) => s.panes[hostId])
  const store = useSftpStore

  const [selected, setSelected] = useState<string[]>([])
  const [pathDraft, setPathDraft] = useState(pane?.path ?? '/')
  const [input, setInput] = useState<InputState | null>(null)
  const [actionPrompt, setActionPrompt] = useState<SftpActionPrompt | null>(null)
  const [chmodTarget, setChmodTarget] = useState<SftpEntry | null>(null)
  const [uploadPrompt, setUploadPrompt] = useState<UploadPromptState | null>(null)
  const [conflict, setConflict] = useState<{
    localPaths: string[]
    dest: string
    names: string[]
  } | null>(null)
  const [infoEntry, setInfoEntry] = useState<SftpEntry | null>(null)
  const [largeFile, setLargeFile] = useState<SftpEntry | null>(null)
  const status = pane?.status
  const [overlayStatus, setOverlayStatus] = useState(status)
  const [overlayVisible, setOverlayVisible] = useState(false)
  if (overlayStatus !== status) {
    setOverlayStatus(status)
    if (!status || status === 'connected') setOverlayVisible(false)
  }

  // 挂载即启动（幂等）；卸载不断开，关闭仅随主机。
  useEffect(() => {
    store.getState().ensureStarted(hostId)
  }, [hostId, store])

  const [previousPath, setPreviousPath] = useState(pane?.path)
  if (previousPath !== pane?.path) {
    setPreviousPath(pane?.path)
    if (pane) setPathDraft(pane.path)
  }

  // 离线遮罩 250ms 防抖；状态切换与卸载均取消旧计时器。
  useEffect(() => {
    if (!status || status === 'connected') return
    const timer = setTimeout(() => setOverlayVisible(true), 250)
    return () => clearTimeout(timer)
  }, [status])

  const entryByPath = (path: string): SftpEntry | null =>
    (pane?.children[parentPath(path)] ?? []).find((e) => e.path === path) ?? null

  const selectedDirPath = useCallback((): string => {
    if (selected.length === 1) {
      const e = entryByPath(selected[0])
      if (e?.isDir) return e.path
    }
    return pane?.path ?? '/'
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, pane?.path, pane?.children])

  /* ---------------- 上传流（对照 beginUploadConfirm/confirmUpload） ---------------- */

  const beginUploadConfirm = useCallback(
    (localPaths: string[], dest: string): void => {
      if (localPaths.length === 0) return
      const filled = dest.trim() === '' ? pane?.path || pane?.root || '/' : dest.trim()
      const first = localPaths[0].split('/').pop() ?? ''
      const summary =
        localPaths.length === 1
          ? first
          : t('sftp.itemsSummary', { name: first, count: localPaths.length })
      setUploadPrompt({ localPaths, destPath: filled, summary })
    },
    [pane?.path, pane?.root, t]
  )

  const typedDestination = (raw: string): string => {
    const trimmed = raw.trim()
    if (trimmed === '') return ''
    if (trimmed.startsWith('/')) return normalizePath(trimmed)
    return normalizePath(joinPath(pane?.path ?? '/', trimmed))
  }

  const confirmUpload = async (rawDest: string): Promise<void> => {
    const dest = typedDestination(rawDest)
    const isDir = dest !== '' && (await window.aterm.sftp.isDirectory(hostId, dest))
    if (!isDir) {
      store.getState().setBanner(hostId, t('sftp.invalidUploadDir'))
      setUploadPrompt(null)
      return
    }
    const conflicts: string[] = []
    for (const local of uploadPrompt?.localPaths ?? []) {
      const name = local.split('/').pop() ?? ''
      if (await window.aterm.sftp.exists(hostId, joinPath(dest, name))) conflicts.push(name)
    }
    setUploadPrompt(null)
    if (conflicts.length === 0) {
      store.getState().upload(hostId, uploadPrompt?.localPaths ?? [], dest)
    } else if (uploadPrompt) {
      setConflict({ localPaths: uploadPrompt.localPaths, dest, names: conflicts })
    }
  }

  const pickAndUpload = useCallback(
    (folders: boolean, dest: string): void => {
      void window.aterm.sftp.pickLocal(folders).then((paths) => {
        if (paths.length > 0) beginUploadConfirm(paths, dest)
      })
    },
    [beginUploadConfirm]
  )

  /* ---------------- 危险操作确认流（对照 prepareDelete/Rename/Move） ---------------- */

  const prepareDelete = useCallback(
    (rawEntries: SftpEntry[]): void => {
      const targets = rawEntries.filter(
        (e) =>
          !rawEntries.some((o) => o.isDir && o.path !== e.path && e.path.startsWith(`${o.path}/`))
      )
      if (targets.length === 0) return
      void (async () => {
        const resolved: string[] = []
        for (const t of targets) {
          resolved.push(await window.aterm.sftp.realpath(hostId, t.path))
        }
        setActionPrompt({
          action: 'delete',
          entries: targets,
          subject: targets.length === 1 ? targets[0].name : String(targets.length),
          detailPaths: resolved,
          hits: guardHits(resolved)
        })
      })()
    },
    [hostId]
  )

  const prepareRename = (entry: SftpEntry, name: string): void => {
    void (async () => {
      const parent = parentPath(entry.path)
      const oldPath = await window.aterm.sftp.realpath(hostId, entry.path)
      const newPath = await window.aterm.sftp.realpath(hostId, joinPath(parent, name))
      setActionPrompt({
        action: 'rename',
        entries: [entry],
        subject: name,
        detailPaths: [oldPath, newPath],
        hits: guardHits([oldPath, newPath]),
        renameName: name
      })
    })()
  }

  const prepareMove = useCallback(
    (entry: SftpEntry, destDir: string): void => {
      if (!canMove(entry, destDir)) return
      void (async () => {
        const destPath = joinPath(destDir, entry.name)
        // 四个检查互不依赖，并行执行（串行会累计 4×RTT，弹窗明显变慢）
        const [exists, from, parent, dest] = await Promise.all([
          window.aterm.sftp.exists(hostId, destPath),
          window.aterm.sftp.realpath(hostId, entry.path),
          window.aterm.sftp.realpath(hostId, parentPath(entry.path)),
          window.aterm.sftp.realpath(hostId, destDir)
        ])
        if (exists) {
          store.getState().setBanner(hostId, t('sftp.destNameExists'))
          return
        }
        setActionPrompt({
          action: 'move',
          entries: [entry],
          subject: entry.name,
          detailPaths: [parent, dest],
          hits: guardHits([from, parent, dest]),
          moveDestDir: destDir
        })
      })()
    },
    [hostId, store, t]
  )

  const prepareTypedMove = (entry: SftpEntry, raw: string): void => {
    const dest = typedDestination(raw)
    void (async () => {
      if (dest === '' || !(await window.aterm.sftp.isDirectory(hostId, dest))) {
        store.getState().setBanner(hostId, t('sftp.invalidMoveDir'))
        return
      }
      if (!canMove(entry, dest)) {
        store.getState().setBanner(hostId, t('sftp.invalidMoveDir'))
        return
      }
      prepareMove(entry, dest)
    })()
  }

  const confirmAction = (): void => {
    if (!actionPrompt) return
    switch (actionPrompt.action) {
      case 'delete':
        for (const e of actionPrompt.entries) void store.getState().remove(hostId, e)
        setSelected((s) => s.filter((p) => !actionPrompt.entries.some((e) => e.path === p)))
        break
      case 'move':
        if (actionPrompt.moveDestDir) {
          void store.getState().move(hostId, actionPrompt.entries[0], actionPrompt.moveDestDir)
        }
        break
      case 'rename':
        if (actionPrompt.renameName) {
          void store.getState().rename(hostId, actionPrompt.entries[0], actionPrompt.renameName)
        }
        break
    }
    setActionPrompt(null)
  }

  /* ---------------- 树动作（对照 outlineActions） ---------------- */

  const actions: SftpTreeActions = useMemo(
    () => ({
      onOpenFile: (e) => {
        if (e.size >= OPEN_FILE_LIMIT) {
          setLargeFile(e)
          return
        }
        onOpenFile(e)
      },
      onInfo: (e) => setInfoEntry(e),
      onRename: (e) =>
        setInput({
          kind: 'rename',
          title: t('common.rename'),
          initial: e.name,
          confirmTitle: t('sftp.next'),
          target: e
        }),
      onMoveTo: (e) =>
        setInput({
          kind: 'moveTo',
          title: t('sftp.moveTo'),
          placeholder: t('sftp.destDirHint'),
          initial: pane?.path ?? '/',
          confirmTitle: t('sftp.move'),
          target: e
        }),
      onChmod: (e) => {
        setChmodTarget(e)
      },
      onNewFile: (dir) =>
        setInput({
          kind: 'newFile',
          title: t('sftp.newFile'),
          placeholder: t('sftp.fileNameHint'),
          initial: '',
          confirmTitle: t('common.create'),
          parent: dir
        }),
      onMkdir: (dir) =>
        setInput({
          kind: 'mkdir',
          title: t('sftp.newFolder'),
          placeholder: t('sftp.namePlaceholder'),
          initial: '',
          confirmTitle: t('common.create'),
          parent: dir
        }),
      onDownload: (e) => store.getState().download(hostId, e),
      onDelete: (entries) => prepareDelete(entries),
      onOpenTerminal: (dir) => onOpenTerminal(dir),
      onUploadFiles: (dir) => pickAndUpload(false, dir),
      onUploadFolders: (dir) => pickAndUpload(true, dir),
      onCopyName: (e) => {
        void navigator.clipboard.writeText(e.name)
        onToast(t('common.copied'))
      },
      onCopyPath: (e) => {
        void navigator.clipboard.writeText(e.path)
        onToast(t('common.copied'))
      },
      onMove: (e, destDir) => prepareMove(e, destDir),
      onUploadPaths: (paths, destDir) => beginUploadConfirm(paths, destDir)
    }),
    [
      hostId,
      pane?.path,
      onOpenFile,
      onOpenTerminal,
      onToast,
      t,
      store,
      prepareDelete,
      prepareMove,
      pickAndUpload,
      beginUploadConfirm
    ]
  )

  /* ---------------- 输入弹窗确认 ---------------- */

  const confirmInput = (value: string): void => {
    const st = input
    setInput(null)
    if (!st) return
    const name = value.trim()
    if (st.kind === 'mkdir') {
      if (name !== '') void store.getState().mkdir(hostId, name, st.parent)
    } else if (st.kind === 'newFile') {
      if (name !== '') void store.getState().touch(hostId, name, st.parent)
    } else if (st.kind === 'rename' && st.target) {
      if (name !== '') prepareRename(st.target, name)
    } else if (st.kind === 'moveTo' && st.target) {
      prepareTypedMove(st.target, value)
    }
  }

  /* ---------------- 渲染 ---------------- */

  const rootListed = pane ? listedEntries(pane, pane.root) : []
  const offlineMessage =
    pane?.status === 'connecting'
      ? t('sftp.connecting')
      : pane?.status === 'disconnected'
        ? t('sftp.disconnected')
        : (pane?.error ?? '')

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-sidebar">
      {/* 工具栏（对照 toolbar） */}
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <IconButton
          variant="toolbar"
          icon={Home}
          frame={22}
          aria-label={t('sftp.home')}
          onClick={() => store.getState().goHome(hostId)}
        />
        <IconButton
          variant="toolbar"
          icon={RotateCw}
          frame={22}
          aria-label={t('common.refresh')}
          onClick={() => store.getState().refresh(hostId)}
        />
        <div className="flex-1" />
        <IconButton
          variant="toolbar"
          icon={ChevronsDownUp}
          frame={22}
          title={t('sftp.collapseAll')}
          onClick={() => store.getState().collapseAll(hostId)}
        />
        <IconButton
          variant="toolbar"
          icon={pane?.showHidden ? Eye : EyeOff}
          frame={22}
          title={pane?.showHidden ? t('sftp.hideHidden') : t('sftp.showHidden')}
          onClick={() => store.getState().toggleHidden(hostId)}
        />
        <IconButton
          variant="toolbar"
          icon={FolderPlus}
          frame={22}
          title={t('sftp.newFolder')}
          onClick={() =>
            setInput({
              kind: 'mkdir',
              title: t('sftp.newFolder'),
              placeholder: t('sftp.namePlaceholder'),
              initial: '',
              confirmTitle: t('common.create'),
              parent: selectedDirPath()
            })
          }
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton variant="toolbar" icon={Upload} frame={22} title={t('common.upload')} />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-36">
            <DropdownMenuItem onClick={() => pickAndUpload(false, selectedDirPath())}>
              {t('sftp.uploadFiles')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => pickAndUpload(true, selectedDirPath())}>
              {t('sftp.uploadFolders')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ChromeSeparator />

      {/* 路径条（对照 pathBar） */}
      <div className="flex shrink-0 items-center gap-1.5 px-2.5 py-1.5">
        <Folder size={11} strokeWidth={2.2} className="shrink-0 text-muted" />
        <input
          className="h-5 min-w-0 flex-1 bg-transparent font-mono text-minor text-fg outline-none"
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') store.getState().go(hostId, pathDraft)
          }}
        />
        {pane?.loading && (
          <Loader2
            size={12}
            className="shrink-0 animate-spin text-muted animate-in fade-in duration-150"
          />
        )}
      </div>
      <ChromeSeparator />

      {/* 树 + 空态 */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {pane && (
          <SftpTreeView
            hostId={hostId}
            pane={pane}
            selected={selected}
            onSelectedChange={setSelected}
            actions={actions}
          />
        )}
        {pane &&
          rootListed.length === 0 &&
          !pane.loading &&
          pane.errors[pane.root] === undefined && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2">
              <Folder size={22} strokeWidth={1.5} className="text-muted" />
              <p className="px-4 text-center text-minor text-muted">
                {pane.status === 'connected'
                  ? t('sftp.emptyDir')
                  : (pane.banner ?? t('sftp.notConnected'))}
              </p>
            </div>
          )}

        {/* 离线遮罩（对照 offlineOverlay） */}
        <div
          className={cn(
            'absolute inset-0 z-20 flex flex-col items-center justify-center gap-2.5 bg-black/45 backdrop-blur-sm transition-opacity duration-200',
            overlayVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
          )}
        >
          {pane?.status === 'error' ? (
            <WifiOff size={22} strokeWidth={1.5} className="text-danger" />
          ) : (
            <Loader2 size={20} className="animate-spin text-muted" />
          )}
          <p className="px-4 text-center text-minor font-medium text-fg">{offlineMessage}</p>
        </div>
      </div>

      {pane && pane.banner && pane.transfers.length === 0 && (
        <p className="shrink-0 px-2.5 py-1.5 text-left text-caption text-danger animate-in fade-in duration-200">
          {pane.banner}
        </p>
      )}

      {/* 弹窗组 */}
      <InputPromptDialog
        title={input?.title ?? ''}
        placeholder={input?.placeholder}
        initial={input?.initial}
        confirmTitle={input?.confirmTitle ?? t('common.ok')}
        hint={input?.parent}
        open={input !== null}
        onConfirm={confirmInput}
        onCancel={() => setInput(null)}
      />
      {chmodTarget && (
        <PermissionDialog
          entry={chmodTarget}
          onCancel={() => setChmodTarget(null)}
          onConfirm={(mode) => {
            const typeBits = (chmodTarget.permissions ?? 0) & 0o170000
            const base = typeBits === 0 ? (chmodTarget.isDir ? 0o040000 : 0o100000) : typeBits
            void store.getState().chmod(hostId, chmodTarget, base | mode)
            setChmodTarget(null)
          }}
        />
      )}
      <ActionConfirmDialog
        prompt={actionPrompt}
        onConfirm={confirmAction}
        onCancel={() => setActionPrompt(null)}
      />
      {uploadPrompt && (
        <UploadDestinationDialog
          summary={uploadPrompt.summary}
          destPath={uploadPrompt.destPath}
          onConfirm={(dest) => void confirmUpload(dest)}
          onCancel={() => setUploadPrompt(null)}
        />
      )}
      {conflict && (
        <UploadConflictDialog
          names={conflict.names}
          onCancel={() => setConflict(null)}
          onSkip={() => {
            const skip = new Set(conflict.names)
            const paths = conflict.localPaths.filter((p) => !skip.has(p.split('/').pop() ?? ''))
            if (paths.length > 0) store.getState().upload(hostId, paths, conflict.dest)
            setConflict(null)
          }}
          onReplace={() => {
            store.getState().upload(hostId, conflict.localPaths, conflict.dest)
            setConflict(null)
          }}
        />
      )}
      {infoEntry && (
        <SftpInfoSheet hostId={hostId} entry={infoEntry} onClose={() => setInfoEntry(null)} />
      )}
      {largeFile && (
        <LargeFileDialog
          entry={largeFile}
          onDownload={() => {
            store.getState().download(hostId, largeFile)
            setLargeFile(null)
          }}
          onCancel={() => setLargeFile(null)}
        />
      )}
    </div>
  )
}
