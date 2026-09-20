import * as SwitchPrimitive from '@radix-ui/react-switch'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-line transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        'data-[state=checked]:border-accent/60 data-[state=checked]:bg-accent data-[state=unchecked]:bg-elevated',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block h-3.5 w-3.5 rounded-full bg-muted shadow-sm transition-transform duration-150',
          'translate-x-0.5 data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-accent-ink',
        )}
      />
    </SwitchPrimitive.Root>
  )
}