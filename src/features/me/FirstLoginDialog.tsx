import { CloudDownload, CloudUpload, HardDrive } from 'lucide-react'
import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { FirstLoginPolicy } from '@/domain/sync'
import { cn, errorMessage } from '@/lib/utils'
import { useSyncStore } from '@/stores/sync-store'

const OPTIONS: {
  policy: FirstLoginPolicy
  icon: typeof CloudUpload
  title: string
  description: string
  danger?: boolean
}[] = [
  {
    policy: 'merge',
    icon: CloudUpload,
    title: '上传本机数据（合并）',
    description: '本机记录会上传；同一条记录云端更新时仍以云端为准。推荐。',
  },
  {
    policy: 'cloud',
    icon: CloudDownload,
    title: '以云端为准',
    description: '清空本机的项目与对话，用云端的版本重建。本机未同步的改动会丢失。',
    danger: true,
  },
  {
    policy: 'localOnly',
    icon: HardDrive,
    title: '暂不同步',
    description: '这次不连云端，数据只留在本机；之后可在「同步」里手动触发。',
  },
]

/**
 * 首次在某台设备登录时的选择：本机已有数据怎么办。
 *
 * 只在「这个账号的本地库还没做过决策」时出现一次，决策记在库里的 syncState，
 * 因此换设备会再问一次，同一台设备不会反复问。
 */
export function FirstLoginDialog() {
  const open = useSyncStore((state) => state.needsPolicy)
  const remote = useSyncStore((state) => state.remote)
  const apply = useSyncStore((state) => state.applyFirstLoginPolicy)
  const [busy, setBusy] = useState<FirstLoginPolicy | null>(null)

  const run = async (policy: FirstLoginPolicy) => {
    setBusy(policy)
    try {
      await apply(policy)
    } catch (error) {
      // 状态里也会有错误文案，这里只是让用户立刻知道点不动了
      console.error('[sync] 首次登录策略失败', errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const cloudRecords = remote?.records ?? 0

  return (
    <Dialog open={open}>
      <DialogContent showClose={false} aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>本机已有数据，怎么和云端合并？</DialogTitle>
          <DialogDescription>
            {cloudRecords > 0
              ? `云端已有 ${cloudRecords} 条记录。`
              : '云端还没有这个账号的数据。'}
            选择只在首次登录时问一次。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {OPTIONS.map((option) => {
            const Icon = option.icon
            const disabled = busy !== null
            return (
              <button
                key={option.policy}
                type="button"
                disabled={disabled}
                onClick={() => void run(option.policy)}
                className={cn(
                  'flex w-full items-start gap-3 rounded-md border border-line px-3 py-2.5 text-left transition-colors duration-150',
                  'hover:border-line-strong hover:bg-line/40 disabled:pointer-events-none disabled:opacity-55',
                  option.danger && 'hover:border-danger/50 hover:bg-danger-soft',
                )}
              >
                <Icon
                  className={cn(
                    'mt-0.5 h-4 w-4 shrink-0',
                    option.danger ? 'text-danger' : 'text-accent',
                  )}
                />
                <span className="min-w-0">
                  <span className="block text-sm text-ink">{option.title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                    {option.description}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        <p className="mt-4 text-xs leading-relaxed text-muted">
          换设备登录时会再问一次；同一台设备只问一次。
        </p>
      </DialogContent>
    </Dialog>
  )
}