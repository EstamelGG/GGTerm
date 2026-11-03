import { useCallback, useEffect, useRef, useState } from 'react'
export function useToast(): {
  toast: { text: string; danger?: boolean } | null
  setToast: React.Dispatch<React.SetStateAction<{ text: string; danger?: boolean } | null>>
  flash: (text: string, danger?: boolean) => void
} {
  /** 全局 toast：danger=true 时红色描边红字（密钥校验失败等错误提示） */
  const [toast, setToast] = useState<{ text: string; danger?: boolean } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flash = useCallback((text: string, danger = false): void => {
    setToast(danger ? { text, danger } : { text })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 4000)
  }, [])
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
    },
    []
  )

  return { toast, setToast, flash }
}
