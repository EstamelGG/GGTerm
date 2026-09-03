import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { defaultAccentHex, groupColors, hexToCss, normalizeHex } from '@/lib/theme'

/** 对照 WindowChrome.swift ColorSwatch：预设色圆点 */
function ColorSwatch({
  hex,
  selected,
  onClick
}: {
  hex: string
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  const [hovering, setHovering] = useState(false)
  return (
    <button
      type="button"
      title={hex}
      className={cn(
        'h-5 w-5 shrink-0 cursor-pointer rounded-full transition-transform duration-100 ease-out',
        hovering && 'scale-[1.08]'
      )}
      style={{
        backgroundColor: hexToCss(hex),
        boxShadow: selected
          ? '0 0 0 2px #fff'
          : hovering
            ? '0 0 0 1.5px rgba(255,255,255,0.65)'
            : 'none'
      }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onClick={onClick}
    />
  )
}

/** 对照 WindowChrome.swift HexColorPicker：预设色板 + 自定义（HEX 输入 + 系统取色器） */
export function HexColorPicker({
  hex,
  onChange,
  presets = groupColors,
  presetLabel
}: {
  hex: string
  onChange: (hex: string) => void
  presets?: string[]
  presetLabel?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(hex.toUpperCase())
  const [focused, setFocused] = useState(false)
  const [lastHex, setLastHex] = useState(hex)

  // prop 变化且输入框未聚焦时同步草稿（渲染期调整，对照 Swift onChange of hex）
  if (hex !== lastHex) {
    setLastHex(hex)
    if (!focused) setDraft(hex.toUpperCase())
  }

  const isCustom = !presets.some((p) => p.toUpperCase() === hex.toUpperCase())
  const draftInvalid = focused && draft !== '' && normalizeHex(draft) === null

  const commit = (): void => {
    const n = normalizeHex(draft)
    if (n) {
      onChange(n)
      setDraft(n)
    } else {
      setDraft(hex.toUpperCase())
    }
  }

  return (
    <div className="flex flex-col items-start gap-2.5">
      {presetLabel && <span className="text-caption font-medium text-muted">{presetLabel}</span>}
      <div className="flex gap-2">
        {presets.map((p) => (
          <ColorSwatch
            key={p}
            hex={p}
            selected={p.toUpperCase() === hex.toUpperCase()}
            onClick={() => {
              onChange(p.toUpperCase())
              setDraft(p.toUpperCase())
            }}
          />
        ))}
      </div>
      <div
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg border bg-raised px-2.5 py-2',
          isCustom ? 'border-at-accent/50' : 'border-line'
        )}
      >
        <span
          className="h-5 w-5 shrink-0 rounded-full border border-fg/20"
          style={{ backgroundColor: hexToCss(hex) }}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-body font-medium text-fg">{t('form.customColor')}</span>
          <input
            type="text"
            spellCheck={false}
            className={cn(
              'w-full bg-transparent font-mono text-caption outline-none',
              draftInvalid ? 'text-danger' : 'text-fg'
            )}
            placeholder="#RRGGBB"
            value={draft}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false)
              commit()
            }}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
            }}
          />
        </div>
        <label
          className="relative h-6 w-9 shrink-0 cursor-pointer overflow-hidden rounded-md border border-line"
          title={t('form.systemColorPicker')}
        >
          <input
            type="color"
            className="absolute -inset-2 h-[calc(100%+16px)] w-[calc(100%+16px)] cursor-pointer"
            value={normalizeHex(hex) ?? defaultAccentHex}
            onChange={(e) => {
              const n = normalizeHex(e.target.value)
              if (n) {
                onChange(n)
                setDraft(n)
              }
            }}
          />
        </label>
      </div>
    </div>
  )
}
