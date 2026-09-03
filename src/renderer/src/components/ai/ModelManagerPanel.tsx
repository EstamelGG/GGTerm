import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, X } from 'lucide-react'
import type {
  AiConfig,
  AiModelBinding,
  AiProvider,
  AiProviderPreset,
  AiScenario
} from '@shared/types'
import { AI_PRESETS, DEFAULT_PROVIDER_ID } from '@shared/ai'
import { errorMessage } from '@shared/error'
import { cn } from '@/lib/utils'
import { Button, ATField, ghostPillCls } from '@/components/form/Buttons'
import { ATTextField } from '@/components/form/Fields'
import { Switch } from '@/components/form/Switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { usePrefsStore } from '@/stores/prefs'

/**
 * AI 模型设置（内嵌于设置页 AI 分区），自上而下：
 *   ① 供应商：名称/BaseURL/API Key + 「获取模型列表」（OpenAI-compatible GET /models，结果缓存进 prefs）
 *   ② 场景配置：对话 / 审批判定 / 会话总结，逐行绑定 供应商 + 模型（title/judge 未设置回退对话模型）。
 * 数据走全局 prefs store，变更即时持久化；对话页模型切换器改写的即「对话」场景绑定。
 */

/** 预设快捷填充（本质均 OpenAI-compatible） */
const PRESET_NEW: { preset: AiProviderPreset; label: string }[] = [
  { preset: 'deepseek', label: 'DeepSeek' },
  { preset: 'qwen', label: 'Qwen' },
  { preset: 'ollama', label: 'Ollama' },
  { preset: 'custom', label: 'Custom' }
]

/** 场景行定义（顺序即展示顺序）；键保持字面量以匹配 i18n 类型 */
const SCENARIOS: {
  key: AiScenario
  labelKey: 'ai.scenarioChat' | 'ai.scenarioJudge' | 'ai.scenarioTitle'
  hintKey?: 'ai.scenarioJudgeHint' | 'ai.scenarioTitleHint'
}[] = [
  { key: 'chat', labelKey: 'ai.scenarioChat' },
  { key: 'judge', labelKey: 'ai.scenarioJudge', hintKey: 'ai.scenarioJudgeHint' },
  { key: 'title', labelKey: 'ai.scenarioTitle', hintKey: 'ai.scenarioTitleHint' }
]

/** radix Select 空值哨兵（其 item value 不允许空串） */
const NONE = '__none__'

interface FetchState {
  state: 'loading' | 'ok' | 'error'
  message?: string
}

export function ModelManagerPanel({
  onToast
}: {
  /** 全局 toast（App flash 直通）：密钥校验失败红色提示 */
  onToast?: (text: string, danger?: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const prefs = usePrefsStore((s) => s.data)
  const update = usePrefsStore((s) => s.update)
  const ai = prefs?.ai ?? null
  const providers = ai?.providers ?? []

  /** 正在编辑的供应商 id；默认第一个 */
  const [editingId, setEditingId] = useState<string | null>(() => providers[0]?.id ?? null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [hasKey, setHasKey] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  /** 空密钥（免密供应商如本地 Ollama）：选中时禁填 key，保存即清除已存密钥 */
  const [noKey, setNoKey] = useState(false)
  /** 每供应商的模型列表拉取状态（按钮转圈 + 结果/错误文案） */
  const [fetchState, setFetchState] = useState<Record<string, FetchState>>({})
  /** 保存按钮结果态：loading=校验中（转圈）/ ok=绿勾 / error=红叉，结果 2s 后回 idle */
  const [saveState, setSaveState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** BaseURL 已改动（改 URL 同样允许「保存并检查连通性」，不再只有改密钥才可保存） */
  const [urlDirty, setUrlDirty] = useState(false)

  const editing = providers.find((p) => p.id === editingId) ?? null

  // 编辑对象切换：清密钥输入与确认态（渲染期调整）；hasKey 为外部系统查询，走 effect 异步回填
  const [prevEditId, setPrevEditId] = useState(editingId)
  if (prevEditId !== editingId) {
    setPrevEditId(editingId)
    setConfirmDelete(false)
    setKeyInput('')
    setHasKey(false)
    setNoKey(false)
    setUrlDirty(false)
  }

  useEffect(() => {
    if (!editingId) return
    let cancelled = false
    window.aterm.ai
      .hasApiKey(editingId)
      .then((v) => {
        if (!cancelled) setHasKey(v)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [editingId])

  // 卸载清理结果态定时器
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    },
    []
  )

  // 模型缓存就绪而场景尚未选模型时默认选第一个（改 store 不能在渲染期做，否则触发 React 警告）
  useEffect(() => {
    if (!ai) return
    const scenarios = { ...ai.scenarios }
    let changed = false
    for (const { key } of SCENARIOS) {
      const binding = scenarios[key]
      const cached = binding ? (ai.modelCache?.[binding.providerId] ?? []) : []
      if (binding && !binding.model && cached.length > 0) {
        scenarios[key] = { ...binding, model: cached[0] }
        changed = true
      }
    }
    if (changed) update({ ai: { ...ai, scenarios } })
  }, [ai, update])

  const patchAi = (patch: Partial<AiConfig>): void => {
    if (!ai) return
    update({ ai: { ...ai, ...patch } })
  }

  const patchProvider = (id: string, patch: Partial<AiProvider>): void => {
    if (!ai) return
    patchAi({ providers: ai.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) })
  }

  /** 新供应商默认名查重：重名自动追加序号（DeepSeek → DeepSeek 1 → DeepSeek 2 …） */
  const uniqueLabel = (base: string): string => {
    const names = new Set((ai?.providers ?? []).map((p) => p.label.trim()))
    if (!names.has(base)) return base
    let n = 1
    while (names.has(`${base} ${n}`)) n++
    return `${base} ${n}`
  }

  const addProvider = (preset: AiProviderPreset): void => {
    if (!ai) return
    const id = `p-${Date.now().toString(36)}`
    const p: AiProvider = {
      id,
      label: uniqueLabel(PRESET_NEW.find((x) => x.preset === preset)?.label ?? 'Custom'),
      baseURL: AI_PRESETS[preset].baseURL
    }
    patchAi({ providers: [...ai.providers, p] })
    setEditingId(id)
  }

  const removeProvider = (): void => {
    if (!ai || !editing) return
    const providers = ai.providers.filter((p) => p.id !== editing.id)
    // 清理引用：场景绑定与模型缓存
    const scenarios = { ...ai.scenarios }
    for (const key of Object.keys(scenarios) as AiScenario[])
      if (scenarios[key]?.providerId === editing.id) scenarios[key] = null
    const modelCache = { ...ai.modelCache }
    delete modelCache[editing.id]
    update({ ai: { ...ai, providers, scenarios, modelCache } })
    setEditingId(providers[0]?.id ?? null)
  }

  /** 结果态短暂展示后回到保存按钮原样 */
  const flashSaveState = (state: 'ok' | 'error'): void => {
    setSaveState(state)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => setSaveState('idle'), 2000)
  }

  const saveKey = (): void => {
    if (!editing || saveState === 'loading') return
    // 空密钥模式：保存空串 = 清除已存密钥；普通模式密钥留空 = 只校验（BaseURL 变更场景），不动已存密钥
    const writesKey = noKey || Boolean(keyInput.trim())
    if (!writesKey && !urlDirty) return
    setSaveState('loading')
    // 未写密钥时失败原因是连通性/地址问题，文案不提「密钥」
    const failLabel = t(writesKey ? 'settings.aiKeyVerifyFailed' : 'settings.aiCheckFailed')
    const write = writesKey
      ? window.aterm.ai.setApiKey(editing.id, noKey ? '' : keyInput.trim())
      : Promise.resolve()
    void write
      .then(() => {
        if (writesKey) {
          const key = noKey ? '' : keyInput.trim()
          setKeyInput('')
          setHasKey(Boolean(key))
        }
        // 保存即校验：能拉到模型才算可用；BaseURL 缺失则直接提示补填（不发请求）
        if (!editing.baseURL.trim()) {
          const message = t('settings.aiBaseURLRequired')
          setFetchState((s) => ({ ...s, [editing.id]: { state: 'error', message } }))
          onToast?.(`${failLabel}: ${message}`, true)
          flashSaveState('error')
        } else {
          fetchModels(editing.id)
            .then(() => {
              setUrlDirty(false)
              flashSaveState('ok')
            })
            .catch((err: unknown) => {
              onToast?.(`${failLabel}: ${errorMessage(err)}`, true)
              flashSaveState('error')
            })
        }
      })
      .catch(() => {
        // 密钥写入失败（钥匙串异常等）：同样走红叉 + toast，避免按钮卡在转圈
        onToast?.(t('settings.aiKeyVerifyFailed'), true)
        flashSaveState('error')
      })
  }

  /**
   * 拉取供应商模型列表（保存密钥校验与场景绑定共用；结果缓存进 prefs）。
   * 返回 Promise 供保存流程串联按钮结果态；失败同时写入 fetchState（行内红字）后继续抛出。
   */
  const fetchModels = (providerId: string): Promise<void> => {
    setFetchState((s) => ({ ...s, [providerId]: { state: 'loading' } }))
    return window.aterm.ai
      .listModels(providerId)
      .then(() => {
        setFetchState((s) => ({ ...s, [providerId]: { state: 'ok' } }))
      })
      .catch((err: unknown) => {
        setFetchState((s) => ({
          ...s,
          [providerId]: { state: 'error', message: errorMessage(err) }
        }))
        throw err
      })
  }

  /** 自动拉取供应商模型列表（无缓存时触发；结果缓存进 prefs，场景下拉与对话切换器共用） */
  const ensureModels = (providerId: string | undefined): void => {
    if (!ai || !providerId) return
    if (ai.modelCache?.[providerId] || fetchState[providerId]?.state === 'loading') return
    const provider = ai.providers.find((p) => p.id === providerId)
    if (!provider?.baseURL.trim()) return
    void fetchModels(providerId).catch(() => {})
  }

  const setBinding = (scenario: AiScenario, binding: AiModelBinding | null): void => {
    if (!ai) return
    patchAi({ scenarios: { ...ai.scenarios, [scenario]: binding } })
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-line p-3">
      {/* ① 供应商管理：左列表 + 右侧编辑表单；两栏抬头同行对齐（列宽与下方内容一致：w-36 / flex-1） */}
      <div className="flex flex-col gap-1.5">
        <div className="flex gap-3">
          <span className="w-36 shrink-0 text-caption font-semibold text-fg">
            {t('settings.aiProviders')}
          </span>
          <span className="min-w-0 flex-1 text-caption font-semibold text-fg">
            {t('settings.aiProviderEdit')}
          </span>
        </div>
        <div className="flex gap-3">
          <div className="flex w-36 shrink-0 flex-col gap-1 rounded-md bg-surface p-1">
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setEditingId(p.id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md bg-raised px-2 py-1.5 text-left transition-colors',
                  p.id === editingId ? 'bg-hover' : 'hover:bg-hover/60'
                )}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    p.id === DEFAULT_PROVIDER_ID ? 'bg-info' : 'border border-muted'
                  )}
                  title={p.id === DEFAULT_PROVIDER_ID ? t('settings.aiProviderDefault') : undefined}
                />
                <span className="min-w-0 flex-1 truncate text-minor text-fg">{p.label}</span>
              </button>
            ))}
            {/* 添加供应商：下拉选预设（DeepSeek/Qwen/Ollama/自定义），选中即创建 */}
            <Select value="" onValueChange={(v) => addProvider(v as AiProviderPreset)}>
              <SelectTrigger
                className="mt-1 h-7 w-full text-minor"
                aria-label={t('settings.aiProviderAdd')}
              >
                <SelectValue placeholder={t('settings.aiProviderAdd')} />
              </SelectTrigger>
              <SelectContent>
                {PRESET_NEW.map((x) => (
                  <SelectItem key={x.preset} value={x.preset}>
                    {x.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {editing ? (
            <div className="flex min-w-0 flex-1 flex-col gap-2.5 rounded-lg border border-line p-3">
              <ATField title={t('ai.modelName')}>
                <ATTextField
                  value={editing.label}
                  onChange={(v) => patchProvider(editing.id, { label: v })}
                />
                {/* 显示名称查重：与其他供应商重名（trim 后比较）即红字提示 */}
                {editing.label.trim() &&
                  providers.some(
                    (p) => p.id !== editing.id && p.label.trim() === editing.label.trim()
                  ) && (
                    <p role="alert" className="text-caption text-danger">
                      {t('settings.aiProviderNameDup')}
                    </p>
                  )}
              </ATField>
              <ATField title={t('settings.aiBaseURL')}>
                <ATTextField
                  value={editing.baseURL}
                  onChange={(v) => {
                    patchProvider(editing.id, { baseURL: v })
                    setUrlDirty(true)
                  }}
                  placeholder="https://api.deepseek.com"
                />
              </ATField>
              <ATField
                title={t('settings.aiApiKey')}
                hint={
                  hasKey ? (
                    <span className="text-caption text-muted">{t('settings.aiApiKeySet')}</span>
                  ) : undefined
                }
              >
                <div className="flex items-center gap-2">
                  <ATTextField
                    value={keyInput}
                    onChange={setKeyInput}
                    placeholder={hasKey ? t('settings.aiApiKeyHint') : ''}
                    className="flex-1"
                    disabled={noKey}
                  />
                  {/* 空密钥开关（免密供应商）：选中禁填 key，保存即清除已存密钥 */}
                  <span className="flex shrink-0 items-center gap-1.5">
                    <Switch
                      label={t('settings.aiNoKey')}
                      on={noKey}
                      onChange={(v) => {
                        setNoKey(v)
                        if (v) setKeyInput('')
                      }}
                    />
                    <button
                      type="button"
                      className="text-caption text-muted transition-colors hover:text-fg"
                      onClick={() => {
                        setNoKey(!noKey)
                        if (!noKey) setKeyInput('')
                      }}
                    >
                      {t('settings.aiNoKey')}
                    </button>
                  </span>
                  {saveState === 'idle' ? (
                    <Button
                      title={t('settings.aiSaveAndVerify')}
                      variant="ghost"
                      size="sm"
                      disabled={!noKey && !keyInput.trim() && !urlDirty}
                      onClick={saveKey}
                    />
                  ) : (
                    /* 校验中转圈 → 通过绿勾 / 失败红叉（2s 后恢复保存按钮） */
                    <button
                      type="button"
                      disabled
                      className={cn(ghostPillCls, 'flex h-6 items-center px-3 py-0')}
                    >
                      {saveState === 'loading' && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />
                      )}
                      {saveState === 'ok' && <Check className="h-3.5 w-3.5 text-ok" />}
                      {saveState === 'error' && <X className="h-3.5 w-3.5 text-danger" />}
                    </button>
                  )}
                </div>
                {/* 密钥校验失败（拉不到模型 / 缺 BaseURL）：密钥下方红色提示 */}
                {fetchState[editing.id]?.state === 'error' && (
                  <p role="alert" className="select-text text-caption text-danger">
                    {fetchState[editing.id]?.message}
                  </p>
                )}
              </ATField>

              <div className="mt-auto">
                {/* 删除（默认供应商不可删；两步确认） */}
                {editing.id !== DEFAULT_PROVIDER_ID &&
                  (confirmDelete ? (
                    <div className="flex items-center gap-1.5">
                      <Button
                        title={t('common.delete')}
                        variant="danger"
                        size="sm"
                        onClick={removeProvider}
                      />
                      <Button
                        title={t('common.cancel')}
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDelete(false)}
                      />
                    </div>
                  ) : (
                    <Button
                      title={t('common.delete')}
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDelete(true)}
                    />
                  ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-caption text-muted">
              {t('ai.modelPickOne')}
            </div>
          )}
        </div>
      </div>

      {/* ② 场景配置：每行 = 场景名 + 供应商下拉 + 模型下拉（无缓存则手输兜底） */}
      <div className="flex flex-col gap-1.5 border-t border-line pt-3">
        <span className="text-caption font-semibold text-fg">{t('settings.aiScenarios')}</span>
        {SCENARIOS.map(({ key, labelKey, hintKey }) => {
          const binding = ai?.scenarios[key] ?? null
          const cached = binding ? (ai?.modelCache?.[binding.providerId] ?? []) : []
          // 模型下拉可用 = 有缓存列表，或拉取失败（手输兜底）；拉取中先显示手输框 + 加载占位
          const modelReady =
            binding && (cached.length > 0 || fetchState[binding.providerId]?.state === 'error')
          const loading = binding ? fetchState[binding.providerId]?.state === 'loading' : false
          const providerValue = binding?.providerId ?? NONE
          const modelValue = binding?.model ?? NONE
          return (
            <div key={key} className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-minor text-fg">{t(labelKey)}</span>
              <Select
                value={providerValue}
                onValueChange={(v) => {
                  setBinding(key, v === NONE ? null : { providerId: v, model: '' })
                  if (v !== NONE) ensureModels(v)
                }}
              >
                <SelectTrigger className="h-7 w-32 shrink-0 text-minor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('ai.modelNone')}</SelectItem>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!binding || loading ? (
                <span
                  className="flex h-7 min-w-0 flex-1 items-center truncate rounded-md border border-line px-2 text-minor text-muted/70"
                  title={hintKey ? t(hintKey) : undefined}
                >
                  {!binding ? t('ai.modelNone') : t('settings.aiModelsLoading')}
                </span>
              ) : modelReady ? (
                <Select
                  value={modelValue}
                  onOpenChange={(open) => open && ensureModels(binding.providerId)}
                  onValueChange={(v) => setBinding(key, { ...binding, model: v === NONE ? '' : v })}
                >
                  <SelectTrigger className="h-7 min-w-0 flex-1 font-mono text-minor">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modelValue === NONE && (
                      <SelectItem value={NONE}>{t('ai.modelNone')}</SelectItem>
                    )}
                    {modelValue !== NONE && !cached.includes(binding.model) && (
                      <SelectItem value={binding.model}>{binding.model}</SelectItem>
                    )}
                    {cached.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <ATTextField
                  value={binding.model}
                  onChange={(v) => setBinding(key, { ...binding, model: v })}
                  placeholder={t('settings.aiModelManual')}
                  className="min-w-0 flex-1 font-mono"
                />
              )}
              <span
                className="w-36 shrink-0 truncate text-caption text-muted"
                title={hintKey ? t(hintKey) : undefined}
              >
                {!binding && key !== 'chat' ? t('ai.scenarioFallback') : hintKey ? t(hintKey) : ''}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
