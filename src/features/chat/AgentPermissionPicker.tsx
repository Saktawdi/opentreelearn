import { ShieldCheck, ShieldQuestion } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

/**
 * 输入框工具栏里的 Agent 权限快速切换胶囊。
 *
 * 交互模式：单次点击直接在「权限: 询问」和「权限: 自动允许」之间来回切换，
 * 无需弹出下拉面板二次选择，更轻更快。
 */
export function AgentPermissionPicker({
  value,
  onChange,
}: {
  /** 'prompt' = 每次询问（默认）；'always_allow' = 自动允许 */
  value: 'prompt' | 'always_allow'
  onChange: (value: 'prompt' | 'always_allow') => void
}) {
  const { t } = useTranslation('chat')
  const auto = value === 'always_allow'

  return (
    <button
      type="button"
      title={t(auto ? 'permission.toggleToPrompt' : 'permission.toggleToAuto')}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onChange(auto ? 'prompt' : 'always_allow')
      }}
      className={cn(
        'inline-flex h-7 select-none items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none transition-[background-color,border-color,color,opacity] duration-150 focus-visible:ring-2 focus-visible:ring-accent/45',
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
      <span className="truncate">
        {t(auto ? 'permission.autoAllow' : 'permission.ask')}
      </span>
    </button>
  )
}
