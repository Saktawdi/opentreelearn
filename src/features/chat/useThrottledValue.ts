import { useEffect, useRef, useState } from 'react'

export function useThrottledValue<T>(value: T, intervalMs = 60): T {
  const [throttled, setThrottled] = useState(value)
  const lastRun = useRef(0)

  useEffect(() => {
    const now = Date.now()
    const elapsed = now - lastRun.current

    if (elapsed >= intervalMs) {
      lastRun.current = now
      setThrottled(value)
      return
    }

    const timer = window.setTimeout(() => {
      lastRun.current = Date.now()
      setThrottled(value)
    }, intervalMs - elapsed)

    return () => window.clearTimeout(timer)
  }, [value, intervalMs])

  return throttled
}