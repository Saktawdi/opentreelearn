import { CloudDownload, CloudUpload, HardDrive } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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

// titleKey/descriptionKey 是 i18n 键：文案在渲染处用 t() 解析，模块级常量只存键
const OPTIONS = [
  {
    policy: 'merge',
    icon: CloudUpload,
    titleKey: 'firstLogin.option.merge.title',
    descriptionKey: 'firstLogin.option.merge.description',
    danger: false,
  },
  {
    policy: 'cloud',
    icon: CloudDownload,
    titleKey: 'firstLogin.option.cloud.title',
    descriptionKey: 'firstLogin.option.cloud.description',
    danger: true,
  },
  {
    policy: 'localOnly',
    icon: HardDrive,
    titleKey: 'firstLogin.option.localOnly.title',
    descriptionKey: 'firstLogin.option.localOnly.description',
    danger: false,
  },
] as const

/**
 * 首次在某台设备登录时的选择：本机已有数据怎么办。
 *
 * 只在「这个账号的本地库还没做过决策」时出现一次，决策记在库里的 syncState，
 * 因此换设备会再问一次，同一台设备不会反复问。
 */
export function FirstLoginDialog() {
  const { t } = useTranslation('me')
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
          <DialogTitle>{t('firstLogin.title')}</DialogTitle>
          <DialogDescription>
            {cloudRecords > 0
              ? t('firstLogin.desc.cloudRecords', { count: cloudRecords })
              : t('firstLogin.desc.noCloud')}
            {t('firstLogin.desc.askOnce')}
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
                  <span className="block text-sm text-ink">{t(option.titleKey)}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                    {t(option.descriptionKey)}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        <p className="mt-4 text-xs leading-relaxed text-muted">
          {t('firstLogin.footer')}
        </p>
      </DialogContent>
    </Dialog>
  )
}