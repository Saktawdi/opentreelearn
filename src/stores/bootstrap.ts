import { useCallback, useEffect, useMemo, useState } from 'react'
import { errorMessage } from '@/lib/utils'
import { useProjectsStore } from './projects-store'
import { useSettingsStore } from './settings-store'

/**
 * 启动阶段的兜底超时。
 *
 * IndexedDB 的请求在极端情况下会永远不 settle（标签页被挂起、数据库被其他标签页
 * 占用在版本变更上、隐私模式下的配额拒绝等）。原来的实现只有一个 `await`，一旦
 * 卡住就永远停在载入页 —— 屏幕近乎空白、控制台干干净净，这正是「页面空白」这类
 * 问题最难排查的形态。给一个上限，让「卡住」退化成「看得见的错误」。
 */
export const BOOTSTRAP_TIMEOUT_MS = 12_000

export type BootstrapPhase = 'loading' | 'ready' | 'error'

export interface BootstrapState {
  phase: BootstrapPhase
  /** 仅在 phase === 'error' 时有值。 */
  message: string | null
  retry: () => void
}

export function useBootstrap(): BootstrapState {
  const [phase, setPhase] = useState<BootstrapPhase>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    const timer = window.setTimeout(() => {
      if (cancelled) return
      setPhase('error')
      setMessage(`本地数据库在 ${BOOTSTRAP_TIMEOUT_MS / 1000} 秒内没有响应`)
    }, BOOTSTRAP_TIMEOUT_MS)

    void (async () => {
      try {
        await Promise.all([
          useSettingsStore.getState().load(),
          useProjectsStore.getState().load(),
        ])
        if (cancelled) return
        window.clearTimeout(timer)
        // 超时之后才姗姗来迟的成功同样接受：这里自愈比停在错误页更有用。
        setPhase('ready')
        setMessage(null)
      } catch (error) {
        if (cancelled) return
        window.clearTimeout(timer)
        console.error('[bootstrap] 本地数据加载失败', error)
        setPhase('error')
        setMessage(errorMessage(error))
      }
    })()

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [attempt])

  // 回到载入态放在事件回调里而不是 effect 体内：effect 里同步 setState 会触发
  // 级联渲染（react-hooks/set-state-in-effect），而这里本来也只有在重试时才需要复位。
  const retry = useCallback(() => {
    setPhase('loading')
    setMessage(null)
    setAttempt((count) => count + 1)
  }, [])

  return useMemo(() => ({ phase, message, retry }), [phase, message, retry])
}
