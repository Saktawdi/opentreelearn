import { useEffect, useState } from 'react'
import { useThrottledValue } from './useThrottledValue'

/**
 * 给「随时间衰减」的展示（保持率热力图、到期提示）用的时钟。
 *
 * 保持率是连续衰减的，但没必要每帧重算：分钟级重算足够表达「今天该复习了」。
 * 定时器负责让画面在没有交互时也会自己更新，`useThrottledValue` 负责压掉
 * 交互引起的抖动 —— 拖拽画布时不会每分钟触发多次重算。
 */
export function useDecayClock(intervalMs = 60_000): number {
  const [raw, setRaw] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setRaw(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])

  return useThrottledValue(raw, intervalMs)
}