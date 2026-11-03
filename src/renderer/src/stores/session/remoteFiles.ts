import { errorMessage } from '@shared/error'
import i18next from 'i18next'
import type { StoreApi } from 'zustand'
import { useSftpStore } from '../sftp'
import type { RemoteFileDoc, SessionState } from './types'
type FileActions = Pick<
  SessionState,
  'openFile' | 'saveFile' | 'reloadFile' | 'closeFile' | 'focusFile' | 'setFileText'
>
export function createRemoteFilesSlice(
  set: StoreApi<SessionState>['setState'],
  get: StoreApi<SessionState>['getState']
): FileActions {
  /** 文档异步操作只更新仍然打开的目标文件，不重新创建已关闭的文档。 */
  function patchFile(hostId: string, fileId: string, patch: Partial<RemoteFileDoc>): void {
    set((s) => ({
      hosts: s.hosts.map((h) =>
        h.id === hostId
          ? { ...h, files: h.files.map((f) => (f.id === fileId ? { ...f, ...patch } : f)) }
          : h
      )
    }))
  }

  return {
    openFile: (hostId, entry) => {
      if (entry.isDir) return
      const host = get().hosts.find((h) => h.id === hostId)
      if (!host) return
      const existing = host.files.find((f) => f.path === entry.path)
      if (existing) {
        set((s) => ({
          hosts: s.hosts.map((h) => (h.id === hostId ? { ...h, focusFileId: existing.id } : h))
        }))
        return
      }
      const doc: RemoteFileDoc = {
        encoding: 'utf8',
        encodingMode: 'auto',
        bom: false,
        confidence: 100,
        readOnly: true,
        id: crypto.randomUUID(),
        path: entry.path,
        name: entry.name,
        size: entry.size,
        text: '',
        saved: '',
        loading: true,
        saving: false,
        error: null
      }
      set((s) => ({
        hosts: s.hosts.map((h) =>
          h.id === hostId ? { ...h, files: [...h.files, doc], focusFileId: doc.id } : h
        )
      }))
      void (async () => {
        try {
          const res = await window.aterm.sftp.readForEdit(hostId, entry.path, entry.size)
          if (
            !get()
              .hosts.find((h) => h.id === hostId)
              ?.files.some((f) => f.id === doc.id)
          )
            return
          if (res.kind === 'text') {
            set((s) => ({
              hosts: s.hosts.map((h) =>
                h.id === hostId
                  ? {
                      ...h,
                      files: h.files.map((f) =>
                        f.id === doc.id
                          ? {
                              ...f,
                              text: res.text,
                              saved: res.text,
                              loading: false,
                              encoding: res.encoding,
                              bom: res.bom,
                              confidence: res.confidence,
                              size: res.size,
                              readOnly: res.lossy || res.binary,
                              error: res.binary
                                ? i18next.t('editor.binaryReadOnly')
                                : res.lossy
                                  ? i18next.t('editor.lossyReadOnly')
                                  : null
                            }
                          : f
                      )
                    }
                  : h
              )
            }))
            return
          }
          // 兜底（>10MB 已在 SftpPane 弹窗拦截）：移除标签页并提示改走下载，不自动下载
          set((s) => ({
            hosts: s.hosts.map((h) => {
              if (h.id !== hostId) return h
              const files = h.files.filter((f) => f.id !== doc.id)
              return {
                ...h,
                files,
                focusFileId:
                  h.focusFileId === doc.id ? (files[files.length - 1]?.id ?? null) : h.focusFileId
              }
            })
          }))
          useSftpStore.getState().setBanner(hostId, i18next.t('sftp.tooLargeBanner', { limit: 10 }))
        } catch (err) {
          const message = errorMessage(err)
          set((s) => ({
            hosts: s.hosts.map((h) =>
              h.id === hostId
                ? {
                    ...h,
                    files: h.files.map((f) =>
                      f.id === doc.id ? { ...f, loading: false, error: message } : f
                    )
                  }
                : h
            )
          }))
        }
      })()
    },

    /** 对照 SessionCenter.saveFile：writeText + saved/error 状态 */
    saveFile: async (hostId, fileId) => {
      const host = get().hosts.find((h) => h.id === hostId)
      const doc = host?.files.find((f) => f.id === fileId)
      if (!host || !doc || doc.saving || doc.loading || doc.readOnly) return false
      if (doc.text === doc.saved) return true
      const text = doc.text
      patchFile(hostId, fileId, { saving: true, error: null })
      try {
        await window.aterm.sftp.writeText(hostId, doc.path, text, doc.encoding, doc.bom)
        patchFile(hostId, fileId, { saving: false, saved: text, error: null })
        const current = get()
          .hosts.find((h) => h.id === hostId)
          ?.files.find((f) => f.id === fileId)
        return !!current && current.text === text
      } catch (err) {
        patchFile(hostId, fileId, { saving: false, error: errorMessage(err) })
        return false
      }
    },

    /** 重新拉取远端内容（编辑器"刷新"按钮；dirty 由 UI 层先行确认） */
    reloadFile: (hostId, fileId, encoding) => {
      const host = get().hosts.find((h) => h.id === hostId)
      const doc = host?.files.find((f) => f.id === fileId)
      if (!host || !doc || doc.loading || doc.saving) return
      const patch = (p: Partial<RemoteFileDoc>): void => patchFile(hostId, fileId, p)
      patch({ loading: true, error: null })
      void (async () => {
        try {
          const mode = encoding ?? doc.encodingMode
          const res = await window.aterm.sftp.readForEdit(hostId, doc.path, doc.size, mode)
          if (res.kind === 'text') {
            patch({
              text: res.text,
              saved: res.text,
              loading: false,
              encoding: res.encoding,
              encodingMode: mode,
              bom: res.bom,
              confidence: res.confidence,
              size: res.size,
              readOnly: res.lossy || res.binary,
              error: res.binary
                ? i18next.t('editor.binaryReadOnly')
                : res.lossy
                  ? i18next.t('editor.lossyReadOnly')
                  : null
            })
            return
          }
          patch({ loading: false, error: i18next.t('sftp.tooLargeBanner', { limit: 10 }) })
        } catch (err) {
          patch({ loading: false, error: errorMessage(err) })
        }
      })()
    },

    /** 对照 SessionCenter.closeFile：焦点回退到最后一个文件或 shell */
    closeFile: (hostId, fileId) => {
      set((s) => ({
        hosts: s.hosts.map((h) => {
          if (h.id !== hostId) return h
          const files = h.files.filter((f) => f.id !== fileId)
          return {
            ...h,
            files,
            focusFileId:
              h.focusFileId === fileId ? (files[files.length - 1]?.id ?? null) : h.focusFileId
          }
        })
      }))
    },

    focusFile: (hostId, fileId) => {
      // 上下分栏：文件焦点与会话焦点独立，不再互相清空
      set((s) => ({
        hosts: s.hosts.map((h) => (h.id === hostId ? { ...h, focusFileId: fileId } : h))
      }))
    },

    setFileText: (hostId, fileId, text) => patchFile(hostId, fileId, { text })
  }
}
