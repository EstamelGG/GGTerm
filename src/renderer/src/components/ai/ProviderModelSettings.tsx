import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AiConfig, AiContextSettings, AiProvider } from '@shared/types'
import { contextSettingsFor, modelSettingsKey } from '@shared/ai'
import { ATField } from '@/components/form/Buttons'
import { ATTextField } from '@/components/form/Fields'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ModelContextSettings } from './ModelContextSettings'

const MANUAL = '__manual_model__'

export function ProviderModelSettings({
  config,
  provider,
  onChange
}: {
  config: AiConfig
  provider: AiProvider
  onChange: (key: string, settings: AiContextSettings) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [choice, setChoice] = useState<string | null>(null)
  const [manual, setManual] = useState(false)
  const saved = Object.keys(config.modelSettings ?? {}).flatMap((key) => {
    try {
      const value: unknown = JSON.parse(key)
      return Array.isArray(value) && value[0] === provider.id && typeof value[1] === 'string'
        ? [value[1]]
        : []
    } catch {
      return []
    }
  })
  const models = [
    ...new Set([
      ...(config.modelCache?.[provider.id] ?? []),
      ...Object.values(config.scenarios).flatMap((b) =>
        b?.providerId === provider.id && b.model ? [b.model] : []
      ),
      ...saved
    ])
  ]
  const preferred =
    config.scenarios.chat?.providerId === provider.id ? config.scenarios.chat.model : models[0]
  const model = (choice ?? preferred ?? models[0] ?? '').trim()
  const binding = { providerId: provider.id, model }
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <ATField title={t('ai.modelContextModel')}>
        {models.length > 0 && (
          <Select
            value={manual ? MANUAL : model || MANUAL}
            onValueChange={(value) => {
              setManual(value === MANUAL)
              setChoice(value === MANUAL ? '' : value)
            }}
          >
            <SelectTrigger aria-label={t('ai.modelContextModel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
              <SelectItem value={MANUAL}>{t('ai.modelContextManual')}</SelectItem>
            </SelectContent>
          </Select>
        )}
        {(manual || models.length === 0) && (
          <ATTextField
            value={choice ?? ''}
            onChange={setChoice}
            placeholder={t('settings.aiModelManual')}
            className="font-mono"
          />
        )}
      </ATField>
      {model && (
        <>
          <p className="break-all text-caption text-muted">
            {t('ai.modelContextBound', { provider: provider.label, model })}
          </p>
          <ModelContextSettings
            key={modelSettingsKey(binding)}
            value={contextSettingsFor(config, binding)}
            onChange={(settings) => onChange(modelSettingsKey(binding), settings)}
          />
        </>
      )}
    </div>
  )
}
