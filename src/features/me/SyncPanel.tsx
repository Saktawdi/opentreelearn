import { CloudOff, CloudUpload, Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { formatRelativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { useSyncStore } from '@/stores/sync-store'

/**
 * 账号下的同步状态与手动触发。
 *
 * P1 只做「手动同步 + 进页面自动同步一次」；写后节流、冲突提示属于 P3。
 */
export function SyncPanel() {
  const phase = useSyncStore((state) => state.phase)
  const error = useSyncStore((state) => state.error)
  const pending = useSyncStore((state) => state.pending)
  const lastSyncedAt = useSyncStore((state) => state.lastSyncedAt)
  const syncNow = useSyncStore((state) => state.syncNow)
  const [running, setRunning] = useState(false)

  const busy = running || phase === 'syncing'

  const run = async () => {
    setRunning(true)
    try {
      const result = await syncNow()
      if (result.ok) {
        toast.success(
          result.pushed + result.pulled > 0
            ? `已同步：上传 ${result.pushed} 项、下载 ${result.pulled} 项`
            : '已是最新',
        )
      } else if (result.error) {
        toast.error(result.error)
      }
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink-soft">
              {busy ? '正在同步…' : error ? '同步失败' : pending > 0 ? `${pending} 项待同步` : '已同步'}
            </span>
            {lastSyncedAt && !busy ? (
              <span className="text-xs text-muted">上次同步 {formatRelativeTime(lastSyncedAt)}</span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            设置与学习项目同步到账号；BYOK 的 API Key 只留在本机。
          </p>
        </div>

        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run()}>
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          立即同步
        </Button>
      </div>

      {error ? (
        <p className={cn('rounded-md border border-danger/35 bg-danger-soft px-3 py-2 text-xs text-danger')}>
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** 同步状态总结里用的小徽标（账号卡片右上角）。 */
export function SyncBadge() {
  const phase = useSyncStore((state) => state.phase)
  const pending = useSyncStore((state) => state.pending)

  if (phase === 'syncing') {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />
  }
  if (phase === 'error') {
    return <CloudOff className="h-3.5 w-3.5 text-danger" />
  }
  if (pending > 0) {
    return <CloudUpload className="h-3.5 w-3.5 text-muted" />
  }
  return null
}