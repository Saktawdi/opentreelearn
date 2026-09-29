import { ShieldCheck, ShieldQuestion } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolPermissionMode } from '@/domain/agent/permissions'
import { cn } from '@/lib/utils'

/**
 * 输入框工具栏里的 Agent 授权偏好（项目级，单档总开关）。
 *
 * 交互模式：单次点击直接在「每次询问」和「自动允许」之间来回切换，
 * 无需弹出下拉面板二次选择，更轻更快。
 *
 * 授权卡只决定**这一次**；免打扰只有一个地方能关，就是这里 —— 放在卡上，
 * 关掉卡片就再也够不着了。
 */
export function AgentPermissionPicker({
  value,
  onChange,
  compactOnMobile = true,
}: {
  value: ToolPermissionMode
  onChange: (value: ToolPermissionMode) => void
  compactOnMobile?: boolean
}) {
  const { t } = useTranslation('chat')
  const auto = value === 'always_allow'
  const label = t(auto ? 'approval.autoAllow' : 'approval.ask')

  return (
    <button
      type="button"
      title={t(auto ? 'approval.toggleToPrompt' : 'approval.toggleToAuto')}
      aria-label={label}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onChange(auto ? 'prompt' : 'always_allow')
      }}
      className={cn(
        'inline-flex h-7 select-none items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none transition-[background-color,border-color,color,opacity] duration-150 focus-visible:ring-2 focus-visible:ring-accent/45',
        compactOnMobile && 'w-7 px-0 sm:w-auto sm:px-2',
        auto
          ? 'bg-accent-soft/70 text-accent hover:bg-accent-soft'
          : 'text-muted hover:bg-elevated hover:text-ink',
      )}
    >
      {auto ? (
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-accent" />
      ) : (
        <ShieldQuestion className="h-3.5 w-3.5 shrink-0 opacity-70" />
      )}
      <span className={cn('truncate', compactOnMobile && 'hidden sm:inline')}>
        {label}
      </span>
    </button>
  )
}
