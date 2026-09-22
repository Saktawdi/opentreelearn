import { useEffect } from 'react'
import { useAccountStore } from './account-store'
import { useSyncStore } from './sync-store'

/**
 * 待推变更的巡检间隔。
 *
 * 巡检本身只读本机 outbox 计数，没有变更就不发网络请求 —— 这是「写后节流自动同步」
 * 的低成本替代：写入侧不必到处挂钩子，代价最多晚一分钟推上去。
 */
export const PENDING_SYNC_POLL_MS = 60_000

/**
 * 账号 + 同步的运行期接线，由 `AppShell` 挂一次（整个应用只有这一份）。
 *
 * 以前这两件事都挂在「我的」页上：不进那一页就既不恢复登录态、也不同步 —— 首页放一天
 * 也不会拉一次云端变更。现在：
 *
 * 1. **登录态变化**驱动同步初始化：已决策过 → 静默同步一次（首屏进首页就会跑）；
 *    没决策过 → 交给首次登录三选一弹窗；退出登录 → 清掉同步状态（数据已切回游客库）。
 * 2. **窗口重新聚焦 / 切回标签页**补一次自动同步，拿到别处的改动（`autoSync` 自带节流）。
 * 3. 定时**巡检本机待推变更**，有就推。
 *
 * 真正的账号恢复在启动阶段完成（见 `stores/bootstrap.ts`）—— 这里只负责「恢复完之后
 * 持续保持同步」，不参与绑库。
 */
export function useSyncRuntime(enabled: boolean): void {
  const status = useAccountStore((state) => state.status)
  const token = useAccountStore((state) => state.token)
  const initialize = useSyncStore((state) => state.initialize)
  const reset = useSyncStore((state) => state.reset)
  const autoSync = useSyncStore((state) => state.autoSync)

  useEffect(() => {
    if (status === 'authenticated') void initialize()
    else if (status === 'anonymous') reset()
  }, [status, initialize, reset])

  useEffect(() => {
    // 有凭据就值得同步（离线恢复失败时 status 仍是 anonymous，但 token 还在）
    if (!enabled || !token) return

    const onWake = () => {
      if (document.visibilityState === 'visible') void autoSync('focus')
    }

    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    const timer = window.setInterval(() => void autoSync('pending'), PENDING_SYNC_POLL_MS)

    return () => {
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
      window.clearInterval(timer)
    }
  }, [enabled, token, autoSync])
}