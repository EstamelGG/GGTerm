// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ATField } from '../src/renderer/src/components/form/Buttons'
import { ATTextField } from '../src/renderer/src/components/form/Fields'
import { SecretField } from '../src/renderer/src/components/form/Secrets'
import { Switch } from '../src/renderer/src/components/form/Switch'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

it('associates visible field titles with plain and secret inputs', () => {
  render(
    <>
      <ATField title="Username">
        <ATTextField value="user" onChange={vi.fn()} />
      </ATField>
      <ATField title="Password">
        <SecretField value="secret" onChange={vi.fn()} />
      </ATField>
    </>
  )
  expect(screen.getByRole('textbox', { name: 'Username' })).toBeTruthy()
  expect(screen.getByLabelText('Password').getAttribute('type')).toBe('password')
})

it('announces a switch name and state and dispatches the next value', () => {
  const onChange = vi.fn()
  render(<Switch label="Monitor" on={false} onChange={onChange} />)
  const button = screen.getByRole('switch', { name: 'Monitor', checked: false })
  fireEvent.click(button)
  expect(onChange).toHaveBeenCalledWith(true)
})
