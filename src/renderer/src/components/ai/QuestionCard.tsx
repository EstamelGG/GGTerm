import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentQuestion } from '@shared/agentQuestion'
import { errorMessage } from '@shared/error'
import { Button } from '@/components/form/Buttons'
import { ATTextField } from '@/components/form/Fields'

export function QuestionCard({ request }: { request: AgentQuestion }): React.JSX.Element {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<number | null | undefined>(undefined)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const send = async (cancel = false): Promise<void> => {
    if (busy || (!cancel && (selected === undefined || (selected === null && !text.trim())))) return
    setBusy(true)
    setError('')
    try {
      if (cancel) await window.aterm.questions.cancel(request.sessionId, request.toolCallId)
      else
        await window.aterm.questions.answer(request.sessionId, request.toolCallId, selected!, text)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <section
      data-input-pending=""
      aria-label={request.question}
      className="rounded-lg border border-line bg-raised p-3 text-body"
    >
      <p className="mb-3 select-text font-medium text-fg">{request.question}</p>
      <div role="radiogroup" aria-label={request.question} className="flex flex-col gap-2">
        {[...request.options, { label: t('ai.questionOther') }].map((option, index) => {
          const value = index === request.options.length ? null : index
          return (
            <button
              key={index}
              type="button"
              role="radio"
              aria-checked={selected === value}
              disabled={busy}
              onClick={() => setSelected(value)}
              className={`flex items-start gap-2 rounded-md border px-3 py-2 text-left disabled:opacity-50 ${selected === value ? 'border-at-accent bg-at-accent/10' : 'border-line hover:bg-hover'}`}
            >
              <span
                aria-hidden="true"
                className={`mt-1 h-3 w-3 shrink-0 rounded-full border ${selected === value ? 'border-at-accent bg-at-accent' : 'border-muted'}`}
              />
              <span>
                <span className="text-body text-fg">{option.label}</span>
                {option.description && (
                  <span className="mt-0.5 block text-minor text-muted">{option.description}</span>
                )}
              </span>
            </button>
          )
        })}
      </div>
      {selected === null && (
        <ATTextField
          autoFocus
          value={text}
          disabled={busy}
          placeholder={t('ai.questionPlaceholder')}
          onChange={(value) => setText(value.slice(0, 4000))}
          className="mt-2"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
      )}
      {error && (
        <p role="alert" className="mt-2 select-text text-minor text-danger">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void send(true)}
          title={t('ai.questionSkip')}
        />
        <Button
          disabled={busy || selected === undefined || (selected === null && !text.trim())}
          onClick={() => void send()}
          title={t('ai.inputSubmit')}
        />
      </div>
    </section>
  )
}
