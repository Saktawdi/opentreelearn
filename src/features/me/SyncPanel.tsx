import { CloudOff, CloudUpload, Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { formatRelativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { useSyncStore } from '@/stores/sync-store'

/**
 * 账号下的同步状态与手动触发。
 *
 * 自动同步（进首页、窗口聚焦、待推变更巡检）在 `useSyncRuntime` 里；这里只是状态展示
 * 与手动入口 —— 需要立刻推上去时不用等节流窗口。
 */
export function SyncPanel() {
  const { t } = useTranslation('me')
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
            ? t('sync.toast.synced', { pushed: result.pushed, pulled: result.pulled })
            : t('sync.toast.upToDate'),
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
              {busy
                ? t('sync.status.syncing')
                : error
                  ? t('sync.status.error')
                  : pending > 0
                    ? t('sync.status.pending', { count: pending })
                    : t('sync.status.synced')}
            </span>
            {lastSyncedAt && !busy ? (
              <span className="text-xs text-muted">
                {t('sync.lastSynced', { time: formatRelativeTime(lastSyncedAt) })}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            {t('sync.description')}
          </p>
        </div>

        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run()}>
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t('sync.action.now')}
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