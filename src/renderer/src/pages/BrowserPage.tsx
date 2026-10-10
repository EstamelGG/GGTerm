import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  X,
  Plus,
  Globe,
  Square,
  MousePointer2,
  LoaderCircle,
  CircleAlert,
  Info,
  ShieldAlert,
  MessageSquarePlus
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAiStore } from '@/stores/ai'
import { useWorkspaceStore } from '@/stores/workspace'
import type { AiBrowserReference } from '@shared/browser'
import type { BrowserState } from '@shared/browser'
import { IconButton, CopyIconButton } from '@/components/ui/IconButton'
import { BrowserCertificateWarning } from '@/components/chrome/BrowserCertificateWarning'
import { ChromeRow } from '@/components/chrome/ChromeRow'
import { Button } from '@/components/form/Buttons'
import { TabChip, TabScrollArea } from '@/components/chrome/TabChip'
import { useSessionStore } from '@/stores/session'
import { errorMessage } from '@shared/error'

export function BrowserPage({
  active,
  obscured,
  onToast,
  notification,
  onDismissNotification
}: {
  notification: { text: string; danger?: boolean } | null
  onDismissNotification: () => void
  active: boolean
  obscured: boolean
  onToast: (message: string, danger?: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [state, setState] = useState<BrowserState>({ tabs: [], foregroundId: null })
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ key: string; value: string } | null>(null)
  const [approvingCertificate, setApprovingCertificate] = useState(false)
  const [picking, setPicking] = useState(false)
  const addressInput = useRef<HTMLInputElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const current = state.tabs.find((tab) => tab.id === selected)
  const certificateBlocked = !!current?.certificateError
  const blank = !current || current.url === 'about:blank'
  const pageBlocked = blank || certificateBlocked || !!current?.error || !!current?.loading
  const addressKey = `${selected ?? ''}:${current?.url ?? ''}`
  const address = draft?.key === addressKey ? draft.value : blank ? '' : (current?.url ?? '')
  const setAddress = (value: string): void => setDraft({ key: addressKey, value })
  const run = (operation: Promise<unknown>): void => {
    void operation.catch((error) => onToast(errorMessage(error), true))
  }
  const initializationError = useEffectEvent((error: unknown) => onToast(errorMessage(error), true))
  useEffect(() => {
    const apply = (next: BrowserState): void => {
      setState(next)
      setSelected((previous) =>
        next.tabs.some((tab) => tab.id === previous)
          ? previous
          : (next.foregroundId ?? next.tabs[0]?.id ?? null)
      )
    }
    let live = true
    let revision = 0
    const off = window.aterm.browser.onChanged((next) => {
      revision++
      apply(next)
    })
    void window.aterm.browser
      .list()
      .then((next) => {
        if (live && revision === 0) {
          apply(next)
          if (next.tabs.length === 0) {
            void window.aterm.browser
              .newTab(false)
              .then((tab) => {
                if (!live) return
                setState((previous) => ({
                  ...previous,
                  tabs: previous.tabs.some((item) => item.id === tab.id)
                    ? previous.tabs
                    : [...previous.tabs, tab]
                }))
                setSelected((previous) => previous ?? tab.id)
              })
              .catch(initializationError)
          }
        }
      })
      .catch(initializationError)
    return () => {
      live = false
      off()
    }
  }, [])
  useEffect(() => {
    const off = window.aterm.browser.onShow((id) => {
      if (id) {
        setSelected(id)
        useSessionStore.getState().setTab({ kind: 'browser' })
      }
    })
    return off
  }, [])
  useLayoutEffect(() => {
    const layout = (): void => {
      const rect = viewport.current?.getBoundingClientRect()
      void window.aterm.browser
        .layout(
          active && !obscured && !pageBlocked ? selected : null,
          rect && active && !obscured && !pageBlocked
            ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            : null
        )
        .catch(() => {})
    }
    layout()
    const observer = new ResizeObserver(layout)
    if (viewport.current) observer.observe(viewport.current)
    window.addEventListener('resize', layout)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', layout)
      void window.aterm.browser.layout(null, null).catch(() => {})
    }
  }, [active, obscured, selected, pageBlocked, notification, picking])
  const attach = async (reference: AiBrowserReference): Promise<void> => {
    useWorkspaceStore.getState().setAiOpen(true)
    if (!useAiStore.getState().activeId) {
      await useAiStore.getState().init()
      if (!useAiStore.getState().activeId && !useAiStore.getState().initError)
        await useAiStore.getState().newSession()
    }
    const ai = useAiStore.getState()
    if (!ai.activeId) throw new Error(ai.initError ?? t('ai.loading'))
    useWorkspaceStore.getState().attachBrowser(ai.activeId, reference)
    useAiStore.setState((s) => ({ viewChatRequest: s.viewChatRequest + 1 }))
  }
  const pick = async (): Promise<void> => {
    if (!current) return
    if (picking) {
      await window.aterm.browser.cancelPick(current.id)
      return
    }
    setPicking(true)
    try {
      const accent = getComputedStyle(document.documentElement)
        .getPropertyValue('--at-accent')
        .trim()
      const reference = await window.aterm.browser.pick(current.id, accent)
      if (reference) await attach(reference)
    } finally {
      setPicking(false)
    }
  }
  const approveCertificate = async (): Promise<void> => {
    if (!current?.certificateError || approvingCertificate) return
    setApprovingCertificate(true)
    try {
      await window.aterm.browser.approveCertificate(current.id, current.certificateError.requestId)
    } finally {
      setApprovingCertificate(false)
    }
  }
  const submit = (): void => {
    if (!address.trim()) return
    const url = /^https?:\/\//i.test(address) ? address : `https://${address}`
    run(current ? window.aterm.browser.navigate(current.id, url) : window.aterm.browser.open(url))
  }
  return (
    <div className={`absolute inset-0 flex flex-col bg-bg ${active ? '' : 'hidden'}`}>
      <ChromeRow>
        <TabScrollArea>
          {state.tabs.map((tab) => (
            <TabChip
              key={tab.id}
              title={tab.url === 'about:blank' ? t('browser.blankTab') : tab.title}
              icon={Globe}
              loading={tab.loading}
              selected={selected === tab.id}
              showClose
              maxWidth={180}
              onClick={() => {
                setSelected(tab.id)
              }}
              onClose={() => run(window.aterm.browser.close(tab.id))}
            />
          ))}
        </TabScrollArea>
        <IconButton
          icon={Plus}
          title={t('browser.newTab')}
          onClick={() => {
            run(
              window.aterm.browser.open('about:blank').then((tab) => {
                setState((previous) => ({
                  ...previous,
                  tabs: previous.tabs.some((item) => item.id === tab.id)
                    ? previous.tabs
                    : [...previous.tabs, tab],
                  foregroundId: tab.id
                }))
                setSelected(tab.id)
                setDraft(null)
                addressInput.current?.focus()
              })
            )
          }}
        />
      </ChromeRow>
      <form
        className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-3"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <IconButton
          icon={ArrowLeft}
          title={t('browser.back')}
          disabled={!current?.canGoBack}
          onClick={() => current && run(window.aterm.browser.control(current.id, 'back'))}
        />
        <IconButton
          icon={ArrowRight}
          title={t('browser.forward')}
          disabled={!current?.canGoForward}
          onClick={() => current && run(window.aterm.browser.control(current.id, 'forward'))}
        />
        <IconButton
          icon={current?.loading ? Square : RefreshCw}
          title={t(current?.loading ? 'browser.stop' : 'browser.reload')}
          disabled={blank}
          onClick={() =>
            current &&
            run(window.aterm.browser.control(current.id, current.loading ? 'stop' : 'reload'))
          }
        />
        <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-full border border-line bg-raised px-3 transition-colors focus-within:border-at-accent/60">
          {current?.loading ? (
            <LoaderCircle
              size={12}
              className="shrink-0 animate-spin text-at-accent motion-reduce:animate-none"
            />
          ) : current?.error || certificateBlocked ? (
            <ShieldAlert size={12} className="shrink-0 text-warn" />
          ) : (
            <Globe size={12} className="shrink-0 text-muted" />
          )}
          <input
            ref={addressInput}
            className="h-full min-w-0 flex-1 bg-transparent font-mono text-minor text-fg outline-none"
            aria-label={t('browser.address')}
            placeholder={t('browser.address')}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </div>
        <IconButton
          icon={ArrowRight}
          title={t('browser.open')}
          disabled={!address.trim()}
          onClick={submit}
        />
        <div className="mx-1 h-4 w-px shrink-0 bg-line" />
        <IconButton
          icon={MessageSquarePlus}
          title={t('browser.attachPage')}
          disabled={pageBlocked || picking}
          onClick={() => current && run(window.aterm.browser.capture(current.id).then(attach))}
        />
        <IconButton
          icon={MousePointer2}
          title={t(picking ? 'browser.cancelPick' : 'browser.pickElement')}
          selected={picking}
          disabled={pageBlocked}
          onClick={() => run(pick())}
        />
      </form>
      {notification && (
        <div
          role={notification.danger ? 'alert' : 'status'}
          className={`flex shrink-0 items-start gap-2 border-b border-line px-3 py-2 text-minor ${notification.danger ? 'bg-danger/10 text-danger' : 'bg-raised text-fg'}`}
        >
          {notification.danger ? (
            <CircleAlert size={14} className="mt-1 shrink-0" />
          ) : (
            <Info size={14} className="mt-1 shrink-0" />
          )}
          <span className="min-w-0 flex-1 cursor-text select-text break-words leading-6">
            {notification.text}
          </span>
          <CopyIconButton value={notification.text} label={t('common.copy')} />
          <IconButton icon={X} title={t('common.close')} onClick={onDismissNotification} />
        </div>
      )}
      {picking && (
        <div className="border-b border-line bg-at-accent/5 px-3 py-2 text-minor text-at-accent">
          {t('browser.pickHint')}
        </div>
      )}
      {current?.certificateTrust && (
        <div
          className="px-3 py-2 text-minor text-warn"
          title={current.certificateTrust.fingerprint}
        >
          {t('browser.certificateTrusted', { origin: current.certificateTrust.origin })}
        </div>
      )}
      <div
        ref={viewport}
        className="relative min-h-0 flex-1 overflow-hidden"
        aria-busy={current?.loading}
      >
        {current?.certificateError && (
          <BrowserCertificateWarning
            certificate={current.certificateError}
            busy={approvingCertificate}
            onContinue={() => run(approveCertificate())}
            onLeave={() =>
              run(
                current.canGoBack
                  ? window.aterm.browser.control(current.id, 'back')
                  : window.aterm.browser.close(current.id)
              )
            }
          />
        )}
        {!certificateBlocked && (blank || current?.error || current?.loading) && (
          <div className="flex h-full overflow-y-auto p-6">
            <div
              className="m-auto flex w-full max-w-md flex-col items-center text-center"
              role={current?.error ? 'alert' : 'status'}
            >
              <div
                className={`mb-5 flex size-14 items-center justify-center rounded-2xl border border-line ${current?.error ? 'bg-danger/10 text-danger' : 'bg-raised text-at-accent'}`}
              >
                {current?.error ? (
                  <CircleAlert size={24} />
                ) : current?.loading ? (
                  <LoaderCircle size={24} className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <Globe size={24} />
                )}
              </div>
              <h2 className="text-title font-semibold text-fg">
                {t(
                  current?.error
                    ? 'browser.loadFailed'
                    : current?.loading
                      ? 'browser.loading'
                      : 'browser.welcome'
                )}
              </h2>
              <p className="mt-2 max-w-full break-words text-body leading-6 text-muted">
                {current?.error
                  ? t('browser.loadFailedHint')
                  : current?.loading
                    ? current.url
                    : t('browser.empty')}
              </p>
              {current?.error && (
                <div className="mt-4 w-full rounded-lg border border-line bg-raised p-3 text-left font-mono text-minor text-muted">
                  <p className="break-all">{current.url}</p>
                  <p className="mt-2 max-h-32 overflow-auto break-all">{current.error}</p>
                </div>
              )}
              {current?.error && (
                <div className="mt-5 flex items-center gap-2">
                  <Button
                    title={t('browser.retry')}
                    onClick={() => run(window.aterm.browser.navigate(current.id, current.url))}
                  />
                  <Button
                    variant="ghost"
                    title={t('browser.editAddress')}
                    onClick={() => {
                      addressInput.current?.focus()
                      addressInput.current?.select()
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
