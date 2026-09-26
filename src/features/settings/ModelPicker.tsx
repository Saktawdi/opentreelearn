import { Check, ChevronDown, Cpu } from 'lucide-react'
import { Fragment, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
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
  placeholder,
  className,
}: {
  value: ModelRef | null | undefined
  onChange: (ref: ModelRef | null) => void
  placeholder?: string
  className?: string
}) {
  const { t } = useTranslation('settings')
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
          <span className="truncate text-xs">{label ?? placeholder ?? t('picker.placeholder')}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[320px] w-[248px] overflow-y-auto">
        {withModels.length === 0 ? (
          <div className="px-2 py-3 text-xs leading-relaxed text-muted">
            {t('picker.empty')}
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
                    <span className="flex-1 truncate font-mono text-xs">{modelId}</span>
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
              <span className="flex-1 text-xs text-muted">{t('picker.clear')}</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}