import { createContext, useContext } from 'react'

export const FieldContext = createContext<string | undefined>(undefined)
export function useFieldLabel(): string | undefined {
  return useContext(FieldContext)
}
