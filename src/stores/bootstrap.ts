import { useCallback, useEffect, useMemo, useState } from 'react'
import i18n from '@/i18n'
import { errorMessage } from '@/lib/utils'
import { useAccountStore } from './account-store'
import { bindStoredAccountDatabase } from './data-session'
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

/**
 * 旧版本升上来（本机有 token 却没记住账号名）时，等账号服务确认身份的上限。
 *
 * 只有这一种情况需要联网才能算出库名。超时就先按游客库跑完启动，用户可以在「我的」
 * 页重试；不在这里等满网络超时，否则离线升级的用户会卡在载入页。
 */
export const IDENTITY_PROBE_TIMEOUT_MS = 1_500

export type BootstrapPhase = 'loading' | 'ready' | 'error'

export interface BootstrapState {
  phase: BootstrapPhase
  /** 仅在 phase === 'error' 时有值。 */
  message: string | null
  retry: () => void
}

/** 给一个 promise 加超时上限：到点就继续，不等它（用于不该挡首屏的网络动作）。 */
function withTimeout(run: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => resolve(), ms)
    const done = () => {
      window.clearTimeout(timer)
      resolve()
    }
    void run.then(done, done)
  })
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
      setMessage(
        i18n.t('common:bootstrap.timeout', { seconds: BOOTSTRAP_TIMEOUT_MS / 1000 }),
      )
    }, BOOTSTRAP_TIMEOUT_MS)

    void (async () => {
      try {
        // 先把库绑对再载入数据（纯本地读取，不联网）：登录用户刷新首页时，画面上与
        // 写入的都必须已经是账号库，否则期间写的内容会在切库后「消失」。
        const needsIdentity = await bindStoredAccountDatabase()
        // 本机没记住账号名（旧版本升级）时才需要联网问一次 —— 有上限，不拖死首屏
        if (needsIdentity) await withTimeout(useAccountStore.getState().restore(), IDENTITY_PROBE_TIMEOUT_MS)

        await Promise.all([
          useSettingsStore.getState().load(),
          useProjectsStore.getState().load(),
        ])
        if (cancelled) return
        window.clearTimeout(timer)
        // 超时之后才姗姗来迟的成功同样接受：这里自愈比停在错误页更有用。
        setPhase('ready')
        setMessage(null)
        // token 是否还有效放到后台校验：库已经绑对了，失败只影响同步可用性。
        // 放在载入之后跑，避免它与载入读的是两个库。
        void useAccountStore.getState().restore()
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
