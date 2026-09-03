import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Server } from 'lucide-react'
import type { HostConnection, HostGroup } from '@shared/types'
import { cn } from '@/lib/utils'
import { useResizePreview } from '@/lib/useResizePreview'
import { errorMessage } from '@shared/error'
import { TOOLBAR_V } from '@/components/chrome/layout'
import { descendantsOf } from '@shared/groupTree'
import { useConnectionsStore } from '@/stores/connections'
import { useLatencyStore, type LatencyStatus } from '@/stores/latency'
import { usePerfStore } from '@/stores/perf'
import { ChromeSeparator } from '@/components/chrome/ChromeSeparator'
import { Button } from '@/components/form/Buttons'
import { GroupSidebar, type SidebarPick } from '@/components/connection/GroupSidebar'
import { ConnectionTable, type SortColumn } from '@/components/connection/ConnectionTable'
import { ConnectionForm, type FormPayload } from '@/components/connection/ConnectionForm'
import { SshConfigImport } from '@/components/connection/SshConfigImport'
import { GroupEditor, type GroupEditorPayload } from '@/components/connection/GroupEditor'
import { DialogShell } from '@/components/ui/DialogShell'

/** 左侧分组侧栏宽度：可拖拽调节，上下限 + localStorage 持久化（对照 HostSessionPage 的 SFTP 分栏 splitter） */
const SIDEBAR_WIDTH_KEY = 'ggterm.sidebarWidth'
const SIDEBAR_MIN = 160
const SIDEBAR_MAX = 480

function loadSidebarWidth(): number {
  const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY)
  const v = raw === null ? NaN : Number(raw)
  return Number.isFinite(v) ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, v)) : 260
}

/** 对照 ConnectionPage.swift：侧栏 + 搜索 + 表格 + 空态 + 删除确认 */
export default function ConnectionPage({
  active,
  perfEnabled,
  onToast,
  onConnect
}: {
  /** 页面是否激活（常驻挂载下由 tab 决定；驱动性能探测的启停） */
  active: boolean
  /** 全局性能监控开关；关闭时指标区仅保留延迟。 */
  perfEnabled: boolean
  onToast: (text: string) => void
  onConnect: (c: HostConnection) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const connections = useConnectionsStore((s) => s.connections)
  const groups = useConnectionsStore((s) => s.groups)
  const loaded = useConnectionsStore((s) => s.loaded)
  const load = useConnectionsStore((s) => s.load)
  const remove = useConnectionsStore((s) => s.remove)
  const create = useConnectionsStore((s) => s.create)
  const removeGroup = useConnectionsStore((s) => s.removeGroup)

  // 侧栏宽度：拖拽调节 + 持久化（splitter 模式同 HostSessionPage 的 SFTP 分栏）
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth())
  const widthPreviewRef = useRef<HTMLDivElement>(null)
  const widthResize = useResizePreview({
    value: sidebarWidth,
    min: SIDEBAR_MIN,
    max: SIDEBAR_MAX,
    onCommit: (next) => {
      setSidebarWidth(next)
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next))
    },
    onPreview: (next) => {
      if (widthPreviewRef.current) widthPreviewRef.current.style.left = `${next - 1}px`
    }
  })
  const previewWidth = widthResize.preview
  const dragging = previewWidth !== null

  const [pick, setPick] = useState<SidebarPick>({ kind: 'all' })
  /** 左侧目录定位请求：表格主机名点击 → { id, n }（n 递增使重复点击同一主机也重新滚动） */
  const [reveal, setReveal] = useState<{ id: string; n: number } | null>(null)
  const [search, setSearch] = useState('')
  const [sortColumn, setSortColumn] = useState<SortColumn>('createdAt')
  const [sortAscending, setSortAscending] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<HostConnection | null>(null)
  const [form, setForm] = useState<FormPayload | null>(null)
  const [groupEditor, setGroupEditor] = useState<GroupEditorPayload | null>(null)
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<HostGroup | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  /** 多选（工具栏导出/删除的动作目标）；批量删除确认弹窗存数量 */
  const [selectedRaw, setSelectedRaw] = useState<Set<string>>(new Set())
  const [bulkDeleteCount, setBulkDeleteCount] = useState<number | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  // 渲染期派生：连接被删（任意途径）后自动剔除悬空 id，避免 effect 级联
  const selectedIds = useMemo(() => {
    const alive = new Set(connections.map((c) => c.id))
    const next = new Set([...selectedRaw].filter((id) => alive.has(id)))
    return next.size === selectedRaw.size ? selectedRaw : next
  }, [selectedRaw, connections])

  const latencyStatus = useLatencyStore((s) => s.status)

  useEffect(() => {
    void load().catch((err) => setLoadError(errorMessage(err)))
  }, [load])

  // 性能快照：页面打开时拉一次，此后靠 perf:sample 事件增量（App 已全局接线）
  useEffect(() => {
    void usePerfStore.getState().loadSnapshot()
  }, [])

  // osName 缓存清理：以全量列表为基准剔除孤儿项（表格拿的是过滤结果，不可作基准）；
  // 必须等 loaded（首载完成前 connections 为空，会把整库缓存误判为孤儿清空）
  useEffect(() => {
    if (!loaded) return
    usePerfStore.getState().prune(connections.map((c) => c.id))
  }, [connections, loaded])

  // 作用域+搜索结果（不含排序；targets 依赖此层，避免 latency 反馈环）
  const scopedSearched = useMemo(() => {
    const scoped = (() => {
      switch (pick.kind) {
        case 'all':
          return connections
        case 'ungrouped':
          return connections.filter((c) => c.groupId === null)
        case 'group': {
          const ids = descendantsOf(pick.id, groups)
          ids.add(pick.id)
          return connections.filter((c) => c.groupId !== null && ids.has(c.groupId))
        }
      }
    })()
    const q = search.trim().toLowerCase()
    return q
      ? scoped.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.host.toLowerCase().includes(q) ||
            c.username.toLowerCase().includes(q)
        )
      : scoped
  }, [connections, groups, pick, search])

  // 排序层（依赖 latency 分档；不影响 targets 引用）
  const filtered = useMemo(() => {
    const searched = scopedSearched
    const latencyValue = (c: HostConnection): number => {
      const s = latencyStatus[c.id]
      if (typeof s === 'number') return s
      if (s === 'unreachable') return Number.MAX_SAFE_INTEGER - 1
      return Number.MAX_SAFE_INTEGER
    }
    const cmp = (a: string, b: string): number =>
      a.localeCompare(b, 'zh-Hans', { sensitivity: 'base' })

    return [...searched].sort((a, b) => {
      const ord = sortAscending ? 1 : -1
      switch (sortColumn) {
        case 'createdAt':
          return ord * (a.createdAt - b.createdAt)
        case 'name':
          return ord * cmp(a.name, b.name)
        case 'host': {
          const h = cmp(a.host, b.host)
          return h !== 0 ? ord * h : ord * (a.port - b.port)
        }
        case 'username':
          return ord * cmp(a.username, b.username)
        case 'latency':
          return ord * (latencyValue(a) - latencyValue(b))
      }
    })
  }, [scopedSearched, sortColumn, sortAscending, latencyStatus])

  // 延迟探测改为 ConnectionTable 内按「稳定可见行」驱动（3s 稳定 + 10s 周期）；此处只保留排序消费

  const toggleSort = (col: Exclude<SortColumn, 'createdAt'>): void => {
    if (sortColumn === col) {
      if (sortAscending) setSortAscending(false)
      else {
        setSortColumn('createdAt')
        setSortAscending(true)
      }
    } else {
      setSortColumn(col)
      setSortAscending(true)
    }
  }

  // 传给 ConnectionTable/HostRow 的回调统一 useCallback：引用稳定是行 memo 命中的前提
  const copyAddress = useCallback(
    (c: HostConnection): void => {
      void navigator.clipboard
        .writeText(c.host)
        .then(() => onToast(t('common.copied')))
        .catch((err) => onToast(errorMessage(err)))
    },
    [onToast, t]
  )

  const toggleSelect = useCallback((id: string): void => {
    setSelectedRaw((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /** 表格主机名点击 → 请求左侧目录定位该主机 */
  const locateConn = useCallback((c: HostConnection): void => {
    setReveal((prev) => ({ id: c.id, n: (prev?.id === c.id ? prev.n : 0) + 1 }))
  }, [])

  /** 全选/取消全选：作用域 = 当前可见行（搜索/分组过滤后） */
  const toggleSelectAll = useCallback((next: boolean): void => {
    setSelectedRaw((prev) => {
      const ids = new Set(prev)
      for (const c of filtered) {
        if (next) ids.add(c.id)
        else ids.delete(c.id)
      }
      return ids
    })
  }, [filtered])

  const openEdit = useCallback((c: HostConnection) => setForm({ kind: 'edit', conn: c }), [])

  /** 导出选中项：基本信息 + 已保存的全部凭据（非空即导，为批量导入预留完整数据）→ JSON 写剪贴板 */
  const exportSelected = (): void => {
    const targets = connections.filter((c) => selectedIds.has(c.id))
    if (targets.length === 0 || actionBusy) return
    setActionBusy(true)
    void (async () => {
      const items = await Promise.all(
        targets.map(async (c) => {
          const s = await window.aterm.secrets.load(c.id)
          const item: Record<string, string | number> = {
            name: c.name,
            host: c.host,
            port: c.port,
            username: c.username,
            authType: c.authType
          }
          if (s.password) item.password = s.password
          if (s.privateKey) {
            item.privateKey = s.privateKey
            if (s.passphrase) item.passphrase = s.passphrase
          }
          return item
        })
      )
      await navigator.clipboard.writeText(JSON.stringify(items, null, 2))
      onToast(t('conn.exported', { count: items.length }))
      setSelectedRaw(new Set())
    })()
      .catch((err) => onToast(errorMessage(err)))
      .finally(() => setActionBusy(false))
  }

  /** 复制连接：配置 + 凭据全同，仅名称加 " - Copy"；显式列字段避免带入原 id/时间戳 */
  const duplicateConn = (c: HostConnection): void => {
    void window.aterm.secrets
      .load(c.id)
      .then((s) =>
        create(
          {
            name: `${c.name} - Copy`,
            host: c.host,
            port: c.port,
            username: c.username,
            authType: c.authType,
            groupId: c.groupId,
            connectTimeout: c.connectTimeout,
            keepaliveInterval: c.keepaliveInterval,
            initCommand: c.initCommand,
            initDir: c.initDir,
            perfDisabled: c.perfDisabled
          },
          s
        )
      )
      .then(() => onToast(t('common.copied')))
      .catch((err) => onToast(errorMessage(err)))
  }

  return (
    <div className="relative flex h-full">
      <div className="flex shrink-0 flex-col" style={{ width: sidebarWidth }}>
        <GroupSidebar
          pick={pick}
          onPick={setPick}
          connections={connections}
          groups={groups}
          reveal={reveal}
          onNewConnection={(gid) => setForm({ kind: 'create', groupId: gid })}
          onNewGroup={(parentId) => setGroupEditor({ kind: 'create', parentId })}
          onRenameGroup={(g) => setGroupEditor({ kind: 'edit', group: g })}
          onDeleteGroup={setDeleteGroupTarget}
          onMoveConnection={(connId, groupId) => {
            void useConnectionsStore
              .getState()
              .update(connId, { groupId })
              .then(() => {
                const name = groups.find((g) => g.id === groupId)?.name ?? t('conn.ungrouped')
                onToast(t('conn.connMovedTo', { name }))
              })
              .catch((err) => onToast(errorMessage(err)))
          }}
          onConnect={onConnect}
          onEdit={(c) => setForm({ kind: 'edit', conn: c })}
          onCopyAddress={copyAddress}
          onDelete={setDeleteTarget}
        />
      </div>
      <div
        className={cn(
          'relative z-10 w-px shrink-0 cursor-col-resize touch-none',
          dragging ? 'bg-at-accent/35' : 'bg-line'
        )}
      >
        <div
          className="absolute inset-y-0 -left-1 w-2.5 cursor-col-resize touch-none"
          {...widthResize.handleProps}
        />
      </div>
      {dragging && previewWidth !== null && (
        <div
          ref={widthPreviewRef}
          className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-at-accent/85"
          style={{ left: sidebarWidth - 1 }}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col bg-bg">
        {/* 工具栏：胶囊搜索 + 新增连接（TOOLBAR_V 常量 = 40px 高，与侧栏头部分割线对齐） */}
        <div className={cn('flex flex-wrap items-center gap-2.5 px-4', TOOLBAR_V)}>
          <div className="flex h-6 w-64 items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 transition-colors duration-100 focus-within:border-at-accent/50">
            <Search size={11} strokeWidth={2.2} className="shrink-0 text-muted" />
            <input
              type="text"
              className="h-full min-w-0 flex-1 bg-transparent text-minor text-fg placeholder:text-muted outline-none"
              placeholder={t('common.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {selectedIds.size > 0 && (
            <>
              <Button
                variant="ghost"
                size="sm"
                title={t('conn.export')}
                disabled={actionBusy}
                onClick={exportSelected}
              />
              <Button
                variant="danger"
                size="sm"
                title={t('common.delete')}
                disabled={actionBusy}
                onClick={() => setBulkDeleteCount(selectedIds.size)}
              />
            </>
          )}
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            title={t('conn.import')}
            onClick={() => setImportOpen(true)}
          />
          <Button
            size="sm"
            title={t('conn.newConnection')}
            onClick={() =>
              setForm({
                kind: 'create',
                groupId: pick.kind === 'group' ? pick.id : null
              })
            }
          />
        </div>
        <ChromeSeparator />
        {loadError && (
          <div role="alert" className="px-4 py-3 text-body text-danger">
            {loadError}
            <Button
              variant="ghost"
              title={t('common.retry')}
              onClick={() => {
                setLoadError(null)
                void load().catch((err) => setLoadError(errorMessage(err)))
              }}
            />
          </div>
        )}

        {loaded && filtered.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2.5">
            <Server size={28} strokeWidth={1.5} className="text-muted" />
            <p className="text-body text-muted">
              {t(
                search.trim()
                  ? 'conn.noSearchResults'
                  : connections.length
                    ? 'conn.emptyGroup'
                    : 'conn.empty'
              )}
            </p>
            {search.trim() ? (
              <Button variant="ghost" title={t('conn.clearSearch')} onClick={() => setSearch('')} />
            ) : (
              <Button
                title={t('conn.newConnection')}
                onClick={() =>
                  setForm({ kind: 'create', groupId: pick.kind === 'group' ? pick.id : null })
                }
              />
            )}
          </div>
        ) : (
          <ConnectionTable
            active={active}
            perfEnabled={perfEnabled}
            connections={filtered}
            sortColumn={sortColumn}
            sortAscending={sortAscending}
            onToggleSort={toggleSort}
            onConnect={onConnect}
            onEdit={openEdit}
            onDuplicate={duplicateConn}
            onDelete={setDeleteTarget}
            onToast={onToast}
            onLocate={locateConn}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
          />
        )}
      </div>

      {form && <ConnectionForm payload={form} onDismiss={() => setForm(null)} />}

      {importOpen && <SshConfigImport onDone={() => setImportOpen(false)} />}

      {groupEditor && <GroupEditor payload={groupEditor} onDismiss={() => setGroupEditor(null)} />}

      {/* 删除分组确认 */}
      <DialogShell
        open={deleteGroupTarget !== null}
        onOpenChange={(o) => !o && setDeleteGroupTarget(null)}
        title={t('conn.deleteGroupTitle')}
        width={400}
        footer={
          <>
            <Button
              variant="ghost"
              title={t('common.cancel')}
              onClick={() => setDeleteGroupTarget(null)}
            />
            <Button
              variant="danger"
              title={t('common.delete')}
              onClick={() => {
                const target = deleteGroupTarget
                if (target) {
                  void removeGroup(target.id)
                    .then((result) => {
                      if (pick.kind === 'group' && result?.removed.includes(pick.id))
                        setPick({ kind: 'all' })
                    })
                    .catch((err) => onToast(errorMessage(err)))
                }
                setDeleteGroupTarget(null)
              }}
            />
          </>
        }
      >
        <p className="text-body text-muted">
          {t('conn.deleteGroupMessage', { name: deleteGroupTarget?.name })}
        </p>
      </DialogShell>

      {/* 删除连接确认 */}
      <DialogShell
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t('conn.deleteConnTitle')}
        width={400}
        footer={
          <>
            <Button
              variant="ghost"
              title={t('common.cancel')}
              onClick={() => setDeleteTarget(null)}
            />
            <Button
              variant="danger"
              title={t('common.delete')}
              onClick={() => {
                if (deleteTarget)
                  void remove(deleteTarget.id).catch((err) => onToast(errorMessage(err)))
                setDeleteTarget(null)
              }}
            />
          </>
        }
      >
        <p className="text-body text-muted">
          {t('conn.deleteConnMessage', { name: deleteTarget?.name })}
        </p>
      </DialogShell>

      {/* 批量删除确认（多选工具栏触发） */}
      <DialogShell
        open={bulkDeleteCount !== null}
        onOpenChange={(o) => !o && setBulkDeleteCount(null)}
        title={t('conn.deleteSelectedTitle')}
        width={400}
        footer={
          <>
            <Button
              variant="ghost"
              title={t('common.cancel')}
              onClick={() => setBulkDeleteCount(null)}
            />
            <Button
              variant="danger"
              title={t('common.delete')}
              disabled={actionBusy}
              onClick={() => {
                setActionBusy(true)
                void Promise.allSettled([...selectedIds].map((id) => remove(id)))
                  .then((results) => {
                    const failure = results.find((result) => result.status === 'rejected')
                    if (failure?.status === 'rejected') onToast(errorMessage(failure.reason))
                    else setSelectedRaw(new Set())
                    setBulkDeleteCount(null)
                  })
                  .finally(() => setActionBusy(false))
              }}
            />
          </>
        }
      >
        <p className="text-body text-muted">
          {t('conn.deleteSelectedMessage', { count: bulkDeleteCount ?? 0 })}
        </p>
      </DialogShell>
    </div>
  )
}

export type { LatencyStatus }
