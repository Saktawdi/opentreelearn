import { Check, ChevronDown, Cpu } from 'lucide-react'
import { Fragment, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ModelRef } from '@/domain/models'
import { cn } from '@/lib/utils'
import { describeModelRef, listAvailableModelRefs } from '@/services/llm/catalog'
import { useSettingsStore } from '@/stores/settings-store'

export function ModelPicker({
  value,
  onChange,
  placeholder = '选择模型',
  className,
}: {
  value: ModelRef | null | undefined
  onChange: (ref: ModelRef | null) => void
  placeholder?: string
  className?: string
}) {
  const providers = useSettingsStore((state) => state.settings.providers)
  const available = useMemo(() => listAvailableModelRefs(providers), [providers])
  const label = describeModelRef(providers, value)

  const withModels = providers.filter((provider) => provider.models.some((model) => model.trim()))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('max-w-[240px] justify-between gap-1.5 text-muted', className)}
        >
          <Cpu className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate text-[12px]">{label ?? placeholder}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[320px] w-[260px] overflow-y-auto">
        {withModels.length === 0 ? (
          <div className="px-2.5 py-3 text-[12px] leading-relaxed text-muted">
            还没有可用模型，先到「配置」页添加提供商与模型。
          </div>
        ) : null}

        {withModels.map((provider, index) => (
          <Fragment key={provider.id}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{provider.label}</DropdownMenuLabel>
            {provider.models
              .map((modelId) => modelId.trim())
              .filter(Boolean)
              .map((modelId) => {
                const selected =
                  value?.providerId === provider.id && value?.modelId === modelId
                return (
                  <DropdownMenuItem
                    key={`${provider.id}:${modelId}`}
                    onSelect={() => onChange({ providerId: provider.id, modelId })}
                  >
                    <span className="flex-1 truncate font-mono text-[12px]">{modelId}</span>
                    {selected ? <Check className="h-3.5 w-3.5 text-accent" /> : null}
                  </DropdownMenuItem>
                )
              })}
          </Fragment>
        ))}

        {available.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(null)}>
              <span className="flex-1 text-[12px] text-muted">清除选择</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}