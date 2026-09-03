import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Ellipsis, Loader2, Server, Settings2, X, Zap } from 'lucide-react'
import type { AuthType, HostConnection, LocalSshKey } from '@shared/types'
import { cn } from '@/lib/utils'
import { errorMessage } from '@shared/error'
import { flattenGroups } from '@shared/groupTree'
import { useConnectionsStore } from '@/stores/connections'
import { ATField, Button, ghostPillCls } from '@/components/form/Buttons'
import { ATNumberField, ATTextArea, ATTextField } from '@/components/form/Fields'
import { SecretEditor, SecretField } from '@/components/form/Secrets'
import { Switch } from '@/components/form/Switch'
import { DialogShell } from '@/components/ui/DialogShell'
import { SegmentedControl } from '@/components/ui/ChoiceChip'
import { IconButton } from '@/components/ui/IconButton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

export type FormPayload =
  { kind: 'create'; groupId: string | null } | { kind: 'edit'; conn: HostConnection }

type TestState = 'idle' | 'testing' | 'success' | 'failure'

/** 配置标签页（对照 XTerminal 编辑页左侧标签：基本/连接/其他，为后续扩展铺位） */
type FormTab = 'basic' | 'conn' | 'other'

const TAB_ITEMS = [
  { id: 'basic', key: 'conn.tabBasic', icon: Server },
  { id: 'conn', key: 'conn.tabConn', icon: Settings2 },
  { id: 'other', key: 'conn.tabOther', icon: Ellipsis }
] as const satisfies { id: FormTab; key: string; icon: typeof Server }[]

/** 测试按钮四态文案 key（渲染处 t()，保证语言切换实时生效） */
const TEST_TITLE_KEYS = {
  idle: 'conn.form.test',
  testing: 'conn.form.testing',
  success: 'conn.form.available',
  failure: 'conn.form.failed'
} as const satisfies Record<TestState, string>

/** 对照 ConnectionForm.swift：新增/编辑连接表单（520 宽 sheet） */
export function ConnectionForm({
  payload,
  onDismiss
}: {
  payload: FormPayload
  onDismiss: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const groups = useConnectionsStore((s) => s.groups)
  const create = useConnectionsStore((s) => s.create)
  const update = useConnectionsStore((s) => s.update)

  const editing = payload.kind === 'edit' ? payload.conn : null

  // 挂载时按 payload 初始化（对照 hydrate；凭据异步回填在下方 effect）
  const init = useMemo(() => {
    if (payload.kind === 'create') {
      return {
        name: '',
        host: '',
        port: 22,
        username: 'root',
        auth: 'password' as AuthType,
        groupId: payload.groupId ?? 'none',
        timeout: 20000,
        keepalive: 5000,
        initCommand: '',
        initDir: '',
        perfDisabled: false,
        jumps: [] as (string | null)[]
      }
    }
    const c = payload.conn
    return {
      name: c.name,
      host: c.host,
      port: c.port,
      username: c.username,
      auth: c.authType,
      groupId: c.groupId ?? 'none',
      timeout: c.connectTimeout,
      keepalive: c.keepaliveInterval,
      initCommand: c.initCommand ?? '',
      initDir: c.initDir ?? '',
      perfDisabled: c.perfDisabled ?? false,
      jumps: (c.jumpHostIds ?? []) as (string | null)[]
    }
  }, [payload])

  const [name, setName] = useState(init.name)
  const [host, setHost] = useState(init.host)
  const [port, setPort] = useState(init.port)
  const [username, setUsername] = useState(init.username)
  const [auth, setAuth] = useState<AuthType>(init.auth)
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [groupId, setGroupId] = useState<string>(init.groupId)
  const [timeout, setTimeoutMs] = useState(init.timeout)
  const [keepalive, setKeepalive] = useState(init.keepalive)
  const [initCommand, setInitCommand] = useState(init.initCommand)
  const [initDir, setInitDir] = useState(init.initDir)
  const [perfDisabled, setPerfDisabled] = useState(init.perfDisabled)
  /** 跳板链（行序即链序，最外层在前；null = 未选择占位行） */
  const [jumps, setJumps] = useState<(string | null)[]>(init.jumps)
  const [testState, setTestState] = useState<TestState>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(!editing)
  const [secretRetry, setSecretRetry] = useState(0)
  const [tab, setTab] = useState<FormTab>('basic')
  const [localKeys, setLocalKeys] = useState<LocalSshKey[] | null>(null)
  const [keysOpen, setKeysOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const testReset = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (payload.kind !== 'edit') return
    let alive = true
    window.aterm.secrets
      .load(payload.conn.id)
      .then((s) => {
        if (!alive) return
        setPassword(s.password)
        setPrivateKey(s.privateKey)
        setPassphrase(s.passphrase)
        setHydrated(true)
        setError(null)
      })
      .catch((err) => {
        if (alive) setError(errorMessage(err))
      })
    return () => {
      alive = false
    }
  }, [payload, secretRetry])

  useEffect(
    () => () => {
      if (testReset.current) clearTimeout(testReset.current)
    },
    []
  )

  const canSave =
    hydrated &&
    !busy &&
    name.trim() !== '' &&
    host.trim() !== '' &&
    username.trim() !== '' &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535

  const canTest = (() => {
    if (!canSave || testState === 'testing') return false
    switch (auth) {
      case 'password':
        return password !== ''
      case 'privateKey':
        return privateKey.trim() !== ''
      case 'manual':
        return false
    }
  })()

  const runTest = (): void => {
    if (testReset.current) clearTimeout(testReset.current)
    setTestState('testing')
    setError(null)
    window.aterm.ssh
      .test({
        host: host.trim(),
        port,
        username: username.trim(),
        authType: auth,
        connectTimeout: timeout,
        password,
        privateKey,
        passphrase,
        jumpHostIds: [...new Set(jumps.filter((j): j is string => !!j && j !== editing?.id))]
      })
      .then(() => setTestState('success'))
      .catch((err) => {
        setTestState('failure')
        setError(errorMessage(err))
      })
      .finally(() => {
        testReset.current = setTimeout(() => setTestState('idle'), 1200)
      })
  }

  const importKey = (file: File): void => {
    if (file.size > 256 * 1024) return
    void file.text().then((text) => setPrivateKey(text))
  }

  const pasteKey = (): void => {
    void navigator.clipboard.readText().then((text) => {
      if (text) setPrivateKey(text)
    })
  }

  /** 展开 ~/.ssh 密钥列表（首次点击拉取；选中即读入文本框） */
  const toggleLocalKeys = (): void => {
    if (keysOpen) {
      setKeysOpen(false)
      return
    }
    if (localKeys === null) {
      void window.aterm.localSsh.listKeys().then((keys) => setLocalKeys(keys))
    }
    setKeysOpen(true)
  }

  const pickLocalKey = (key: LocalSshKey): void => {
    void window.aterm.localSsh
      .readKey(key.path)
      .then((text) => {
        setPrivateKey(text)
        setKeysOpen(false)
      })
      .catch(() => {
        // 读失败保持列表展开，用户可换一个或改用文件导入
      })
  }

  const persist = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    const gid = groupId === 'none' ? null : groupId
    const secrets =
      auth === 'manual'
        ? { password: '', privateKey: '', passphrase: '' }
        : { password, privateKey, passphrase }
    const patch = {
      name: name.trim(),
      host: host.trim(),
      port,
      username: username.trim(),
      authType: auth,
      groupId: gid,
      connectTimeout: Number.isFinite(timeout) ? timeout : 20000,
      keepaliveInterval: Number.isFinite(keepalive) ? keepalive : 5000,
      initCommand: initCommand.trim(),
      initDir: initDir.trim(),
      perfDisabled,
      jumpHostIds: [...new Set(jumps.filter((j): j is string => !!j && j !== editing?.id))]
    }
    try {
      if (editing) {
        if (!(await update(editing.id, patch, secrets))) throw new Error(t('conn.saveMissing'))
      } else {
        await create(patch, secrets)
      }
      onDismiss()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && !busy && onDismiss()}
      dismissable={!busy}
      title={editing ? t('conn.editConnection') : t('conn.newConnection')}
      width={720}
      preventAutoFocus
      contentClassName="flex max-h-[70vh] min-h-[400px] overflow-hidden p-0"
      footerAside={<ConnectionTestButton state={testState} disabled={!canTest} onClick={runTest} />}
      footer={
        <>
          <Button variant="ghost" title={t('common.cancel')} disabled={busy} onClick={onDismiss} />
          <Button
            title={editing ? t('common.save') : t('common.create')}
            disabled={!canSave}
            onClick={() => void persist()}
          />
        </>
      }
    >
      {/* 左侧标签栏 + 右侧内容区（各自独立滚动） */}
      <nav className="flex w-[128px] shrink-0 flex-col gap-0.5 border-r border-line bg-sidebar p-2">
        {TAB_ITEMS.map(({ id, key, icon: Icon }) => (
          <button
            key={id}
            disabled={busy}
            type="button"
            className={cn(
              'flex items-center gap-2 rounded-md px-2.5 py-[7px] text-left text-body transition-colors duration-150 outline-none focus-visible:ring-[1.5px] focus-visible:ring-at-accent/70',
              tab === id
                ? 'bg-raised font-medium text-fg'
                : 'text-muted hover:bg-hover/55 hover:text-fg'
            )}
            onClick={() => setTab(id)}
          >
            <Icon size={12.5} strokeWidth={2} className={tab === id ? 'text-at-accent' : ''} />
            {t(key)}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto p-3.5">
        {error && (
          <p
            role="alert"
            className="mb-3 whitespace-pre-wrap break-words text-body text-danger select-text"
          >
            {error}
          </p>
        )}
        {!hydrated && (
          <div className="mb-3">
            <Button
              variant="ghost"
              title={t('common.retry')}
              onClick={() => setSecretRetry((n) => n + 1)}
            />
          </div>
        )}
        <fieldset disabled={busy || !hydrated} className="min-w-0">
          {tab === 'basic' && (
            <div className="flex flex-col gap-2.5">
              <div className="flex gap-2">
                <ATField title={t('conn.form.group')} className="flex-1">
                  {/* 触发器/列表项带分组色点（与侧栏一致的颜色锚点） */}
                  <Select value={groupId} onValueChange={setGroupId}>
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        <span className="flex items-center gap-1.5">
                          {groups.find((g) => g.id === groupId) && (
                            <span
                              className="h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{
                                backgroundColor: groups.find((g) => g.id === groupId)?.colorHex
                              }}
                            />
                          )}
                          {groups.find((g) => g.id === groupId)?.name ?? t('conn.form.noGroup')}
                        </span>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t('conn.form.noGroup')}</SelectItem>
                      {flattenGroups(groups).map(({ group, depth }) => (
                        <SelectItem key={group.id} value={group.id}>
                          <span
                            className="flex items-center gap-1.5"
                            style={{ paddingLeft: depth * 16 }}
                          >
                            <span
                              className="h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{ backgroundColor: group.colorHex }}
                            />
                            {group.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </ATField>
                <ATField title={t('conn.form.name')} required className="flex-1">
                  <ATTextField
                    value={name}
                    onChange={setName}
                    placeholder={t('conn.form.namePlaceholder')}
                  />
                </ATField>
              </div>

              <div className="flex gap-2">
                <ATField title={t('conn.form.host')} required className="min-w-0 flex-1">
                  <ATTextField
                    value={host}
                    onChange={setHost}
                    placeholder={t('conn.form.hostPlaceholder')}
                  />
                </ATField>
                <ATField title={t('conn.form.port')} required className="w-16 shrink-0">
                  <ATNumberField value={port} onChange={setPort} />
                </ATField>
                <ATField title={t('conn.form.username')} required className="min-w-0 flex-1">
                  <ATTextField value={username} onChange={setUsername} />
                </ATField>
              </div>

              <ATField title={t('conn.form.authMethod')}>
                <div className="flex items-center gap-2">
                  <SegmentedControl
                    className="h-8 items-center px-[3px]"
                    value={auth}
                    onChange={setAuth}
                    options={([
                      ['password', 'conn.form.authPassword'],
                      ['privateKey', 'conn.form.authPrivateKey'],
                      ['manual', 'conn.form.authManual']
                    ] as const).map(([value, key]) => ({ value, label: t(key) }))}
                  />
                  {/* 密钥模式的口令就近放选择行右侧，省一个独立字段位 */}
                  {auth === 'privateKey' && (
                    <SecretField
                      value={passphrase}
                      onChange={setPassphrase}
                      placeholder={t('conn.form.passphrase')}
                      className="ml-auto w-56"
                    />
                  )}
                </div>
              </ATField>

              {auth === 'password' && (
                <ATField title={t('conn.form.loginPassword')}>
                  <SecretField value={password} onChange={setPassword} />
                </ATField>
              )}
              {auth === 'privateKey' && (
                <>
                  <ATField title={t('conn.form.privateKey')}>
                    <div className="flex flex-col gap-1.5">
                      <SecretEditor
                        value={privateKey}
                        onChange={setPrivateKey}
                        placeholder={t('conn.form.privateKeyPlaceholder')}
                        minHeight={68}
                      />
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          title={t('conn.form.importKey')}
                          onClick={() => fileRef.current?.click()}
                        />
                        <Button
                          variant="ghost"
                          title={t('conn.form.pasteKey')}
                          onClick={pasteKey}
                        />
                        <Button
                          variant="ghost"
                          title={t('conn.form.localKeys')}
                          onClick={toggleLocalKeys}
                        />
                      </div>
                      {keysOpen && (
                        <div className="max-h-28 overflow-y-auto rounded-lg border border-line bg-raised/60">
                          {localKeys === null ? (
                            <p className="px-2.5 py-2 text-caption text-muted">
                              {t('conn.form.loadingKeys')}
                            </p>
                          ) : localKeys.length === 0 ? (
                            <p className="px-2.5 py-2 text-caption text-muted">
                              {t('conn.form.noLocalKeys')}
                            </p>
                          ) : (
                            localKeys.map((k) => (
                              <button
                                key={k.path}
                                type="button"
                                className="block w-full px-2.5 py-1.5 text-left font-mono text-minor text-fg transition-colors duration-150 hover:bg-hover"
                                onClick={() => pickLocalKey(k)}
                              >
                                {k.name}
                              </button>
                            ))
                          )}
                        </div>
                      )}
                      <input
                        ref={fileRef}
                        type="file"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          if (f) importKey(f)
                          e.target.value = ''
                        }}
                      />
                    </div>
                  </ATField>
                </>
              )}
              {auth === 'manual' && (
                <p className="pt-0.5 text-caption leading-relaxed text-muted">
                  {t('conn.form.manualHint')}
                </p>
              )}
            </div>
          )}

          {tab === 'conn' && (
            <div className="flex flex-col gap-2.5">
              <div className="flex gap-2">
                <ATField title={t('conn.form.connectTimeout')} className="flex-1">
                  <ATNumberField value={timeout} onChange={setTimeoutMs} />
                </ATField>
                <ATField title={t('conn.form.keepalive')} className="flex-1">
                  <ATNumberField value={keepalive} onChange={setKeepalive} />
                </ATField>
              </div>
              <p className="text-caption leading-relaxed text-muted">
                {t('conn.form.keepaliveHint')}
              </p>

              <JumpChainEditor value={jumps} onChange={setJumps} selfId={editing?.id ?? null} />

              <ATField title={t('conn.form.initDir')}>
                <ATTextField
                  value={initDir}
                  onChange={setInitDir}
                  placeholder={t('conn.form.initDirPh')}
                />
              </ATField>
              <ATField title={t('conn.form.initCommand')}>
                <ATTextArea
                  value={initCommand}
                  onChange={setInitCommand}
                  minHeight={60}
                  placeholder={t('conn.form.initCommandPh')}
                />
              </ATField>
            </div>
          )}

          {tab === 'other' && (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between pt-1">
                <div className="flex flex-col gap-0.5">
                  <span className="text-body text-fg">{t('conn.form.disableMonitor')}</span>
                  <span className="text-caption leading-relaxed text-muted">
                    {t('conn.form.disableMonitorHint')}
                  </span>
                </div>
                <Switch
                  label={t('conn.form.disableMonitor')}
                  on={perfDisabled}
                  onChange={setPerfDisabled}
                />
              </div>
            </div>
          )}
        </fieldset>
      </div>
    </DialogShell>
  )
}

/** 跳板链编辑器：多行下拉（行序即链序，最外层在前）；manual 主机显示但禁选 */
function JumpChainEditor({
  value,
  onChange,
  selfId
}: {
  value: (string | null)[]
  onChange: (next: (string | null)[]) => void
  selfId: string | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const connections = useConnectionsStore((s) => s.connections)
  const usable = connections.filter((c) => c.id !== selfId)

  const setRow = (i: number, id: string): void => {
    onChange(value.map((v, idx) => (idx === i ? id : v)))
  }
  const removeRow = (i: number): void => {
    onChange(value.filter((_, idx) => idx !== i))
  }

  return (
    <ATField title={t('conn.form.jumpChain')}>
      <div className="flex flex-col gap-1.5">
        {value.length === 0 && (
          <p className="text-caption leading-relaxed text-muted">{t('conn.form.jumpEmpty')}</p>
        )}
        {value.map((id, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Select value={id ?? undefined} onValueChange={(v) => setRow(i, v)}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder={t('conn.form.jumpPick')} />
              </SelectTrigger>
              <SelectContent>
                {usable
                  // 已被其它行选中的不再重复出现（本行自身保留，便于换选）
                  .filter((c) => c.id === id || !value.includes(c.id))
                  .map((c) => (
                    <SelectItem
                      key={c.id}
                      value={c.id}
                      disabled={c.authType === 'manual'}
                      className={c.authType === 'manual' ? 'text-muted/70' : ''}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="truncate">
                          {c.name}（{c.host}:{c.port}）
                        </span>
                        {c.authType === 'manual' && (
                          <span className="shrink-0 text-caption text-muted">
                            {t('conn.form.jumpManualHint')}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <IconButton
              icon={X}
              size={11}
              frame={26}
              aria-label={t('common.delete')}
              onClick={() => removeRow(i)}
            />
          </div>
        ))}
        <div>
          <Button
            variant="ghost"
            title={t('conn.form.addJump')}
            disabled={usable.length === 0}
            onClick={() => onChange([...value, null])}
          />
        </div>
        {value.length > 0 && (
          <p className="text-caption leading-relaxed text-muted">{t('conn.form.jumpChainHint')}</p>
        )}
      </div>
    </ATField>
  )
}

/** 测试按钮四态（复用 ghost 胶囊基底 + 态色边框）+ 1.2s 复位 */
function ConnectionTestButton({
  state,
  disabled,
  onClick
}: {
  state: TestState
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const title = t(TEST_TITLE_KEYS[state])
  const Icon = { idle: Zap, testing: Loader2, success: Check, failure: X }[state]
  const fg = state === 'success' ? 'text-ok' : state === 'failure' ? 'text-danger' : 'text-fg'
  const border =
    state === 'success' ? 'border-ok/45' : state === 'failure' ? 'border-danger/45' : 'border-line'

  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(ghostPillCls, 'inline-flex items-center gap-1.5', fg, border)}
      onClick={onClick}
    >
      <Icon
        size={11}
        strokeWidth={2.2}
        className={state === 'testing' ? 'animate-spin' : undefined}
      />
      <span key={title} className="animate-[latency-in_0.2s_ease-in-out]">
        {title}
      </span>
    </button>
  )
}
