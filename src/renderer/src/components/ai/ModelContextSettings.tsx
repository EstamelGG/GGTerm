import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AiContextSettings } from '@shared/types'
import { MAX_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW } from '@shared/ai'
import { ATField } from '@/components/form/Buttons'
import { ATTextField } from '@/components/form/Fields'
import { Switch } from '@/components/form/Switch'

export function ModelContextSettings({
  value,
  onChange
}: {
  value: AiContextSettings
  onChange: (value: AiContextSettings) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [edit, setEdit] = useState<{ base: number; text: string } | null>(null)
  const draft = edit?.base === value.contextWindow ? edit.text : String(value.contextWindow)
  const size = Number(draft)
  const valid = Number.isInteger(size) && size >= MIN_CONTEXT_WINDOW && size <= MAX_CONTEXT_WINDOW
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <ATField title={t('ai.contextWindow')}>
        <ATTextField
          value={draft}
          onChange={(text) => {
            setEdit({ base: value.contextWindow, text })
            const contextWindow = Number(text)
            if (
              Number.isInteger(contextWindow) &&
              contextWindow >= MIN_CONTEXT_WINDOW &&
              contextWindow <= MAX_CONTEXT_WINDOW
            )
              onChange({ ...value, contextWindow })
          }}
          className="max-w-56 font-mono"
        />
      </ATField>
      <p className={valid ? 'text-caption text-muted' : 'text-caption text-danger'}>
        {t(valid ? 'ai.contextWindowHint' : 'ai.contextWindowInvalid')}
      </p>
      <div className="flex items-center gap-2">
        <Switch
          label={t('ai.autoCompress')}
          on={value.autoCompress}
          onChange={(autoCompress) => onChange({ ...value, autoCompress })}
        />
        <span className="text-minor text-fg">{t('ai.autoCompress')}</span>
      </div>
      <p className="text-caption text-muted">{t('ai.autoCompressHint')}</p>
    </div>
  )
}
