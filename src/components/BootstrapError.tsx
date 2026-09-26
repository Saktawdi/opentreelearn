import { AlertTriangle, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

interface BootstrapErrorProps {
  message: string | null
  onRetry: () => void
}

/**
 * 启动失败时的可见错误态。
 *
 * 存在的意义是「别再白屏」：本地数据读不出来时，应用既可能停在只闪着一行小字的
 * 载入页，也可能带着空 store 渲染出一个什么都没有的列表 —— 两种都像页面坏了却
 * 不给任何线索。这里把原因、影响范围和可执行的动作一次性摆出来。
 */
export function BootstrapError({ message, onRetry }: BootstrapErrorProps) {
  const { t } = useTranslation('components')
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-md rounded-lg border border-danger/40 bg-danger-soft/60 p-5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-medium text-ink">{t('bootstrap.title')}</h2>
            <p className="mt-1 break-words font-mono text-xs leading-relaxed text-danger">
              {message ?? t('bootstrap.unknownError')}
            </p>
            <p className="mt-3 text-xs leading-relaxed text-ink-soft">
              {t('bootstrap.description')}
            </p>
            <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
              <RotateCcw className="h-3.5 w-3.5" />
              {t('bootstrap.retry')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
