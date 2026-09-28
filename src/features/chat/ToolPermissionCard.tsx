import { Check, ShieldQuestion, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import type { ToolPermissionDecision } from '@/domain/agent/permissions'
import type { ToolApprovalRequest } from '@/stores/tool-approval-store'
import { Button } from '@/components/ui/button'
import { ENTER_SOFT } from '@/lib/motion'

interface ToolPermissionCardProps {
  request: ToolApprovalRequest
  /** 后面还排着几项：让用户知道点完这一张还有下一张 */
  queued: number
  onRespond: (decision: ToolPermissionDecision) => void
}

/**
 * Agent 举手要调一个需授权的工具时，浮在输入框上方的授权卡。
 *
 * 内容全部由 `request.prompt` 驱动（域层出 i18n 键，这里只渲染）——卡片不认识
 * 具体工具，将来加工具不用改这个组件。写工具必然走这里；读工具只有主动取
 * 开放区（当前项目）之外的数据才会走。
 *
 * 这里只决定**这一次**。长期偏好（自动允许）在输入框工具栏的
 * AgentPermissionPicker 上切 —— 把开关放这里，切走了之后就再也够不着。
 */
export function ToolPermissionCard({ request, queued, onRespond }: ToolPermissionCardProps) {
  const { t } = useTranslation('chat')
  const { prompt } = request

  return (
    <motion.div
      initial={{ opacity: 0, y: -10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={ENTER_SOFT}
      className="mx-5 mb-3 overflow-hidden rounded-xl border border-accent/40 bg-surface/95 p-3.5 shadow-sm backdrop-blur-sm"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <ShieldQuestion className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-xs text-ink">{t(prompt.title.key, prompt.title.params)}</span>
            <span className="inline-flex items-center gap-0.5 rounded bg-accent-soft px-1.5 py-0.2 text-2xs text-accent">
              <Sparkles className="h-2.5 w-2.5" />
              Agent
            </span>
          </div>

          {prompt.rows.length > 0 && (
            <dl className="mt-1.5 space-y-0.5">
              {prompt.rows.map((row) => (
                <div key={row.label.key} className="flex gap-1.5 text-2xs leading-relaxed">
                  <dt className="shrink-0 text-faint">{t(row.label.key, row.label.params)}</dt>
                  <dd className="min-w-0 flex-1 break-words text-ink-soft">
                    {t(row.value.key, row.value.params)}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {prompt.reason && (
            <p className="mt-1.5 line-clamp-3 rounded-md border border-line/60 bg-elevated/40 px-2 py-1 text-2xs text-muted">
              {prompt.reason}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => onRespond('allow')}
              className="h-7 px-2.5 text-2xs font-medium"
            >
              <Check className="mr-1 h-3 w-3" />
              {t('approval.allow')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRespond('deny')}
              className="h-7 px-2 text-2xs text-muted hover:text-danger"
            >
              <X className="mr-1 h-3 w-3" />
              {t('approval.deny')}
            </Button>
            {queued > 0 && (
              <span className="text-2xs text-faint">{t('approval.queued', { count: queued })}</span>
            )}
            <span className="ml-auto text-2xs text-faint">{t('approval.hint')}</span>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
