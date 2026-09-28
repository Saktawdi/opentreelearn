import { Brain, Check, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import type { ToolPermissionDecision, ToolPermissionRequest } from '@/domain/agent/permissions'
import { Button } from '@/components/ui/button'
import { ENTER_SOFT } from '@/lib/motion'

interface ToolPermissionCardProps {
  request: ToolPermissionRequest
  onRespond: (decision: ToolPermissionDecision) => void
}

/**
 * Agent 试图调用需授权工具（如更新学习评估）时，在执行层拦截后弹出的权限确认卡片。
 *
 * 这里只决定**这一次**：确认或拒绝。长期偏好（自动允许）在输入框工具栏的
 * AgentPermissionPicker 上切 —— 卡片本身只在询问模式下出现，把开关放这里
 * 就切走了再也够不着。
 */
export function ToolPermissionCard({ request, onRespond }: ToolPermissionCardProps) {
  const { t } = useTranslation('chat')

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
          <Brain className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-xs text-ink">
              {t('permission.requestTitle')}
            </span>
            <span className="inline-flex items-center gap-0.5 rounded bg-accent-soft px-1.5 py-0.2 text-2xs text-accent">
              <Sparkles className="h-2.5 w-2.5" />
              Agent
            </span>
          </div>
          <p className="mt-1 text-2xs leading-relaxed text-ink-soft">
            {t('permission.requestDesc', { title: request.nodeTitle })}
          </p>
          {request.reason && (
            <p className="mt-1 rounded-md border border-line/60 bg-elevated/40 px-2 py-1 text-2xs text-muted">
              {request.reason}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => onRespond('allow_once')}
              className="h-7 px-2.5 text-2xs font-medium"
            >
              <Check className="mr-1 h-3 w-3" />
              {t('permission.allowOnce')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRespond('deny')}
              className="h-7 px-2 text-2xs text-muted hover:text-danger"
            >
              <X className="mr-1 h-3 w-3" />
              {t('permission.deny')}
            </Button>
            <span className="ml-auto text-2xs text-faint">{t('permission.autoHint')}</span>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
