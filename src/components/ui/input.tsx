import type { InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-lg border border-line bg-canvas/60 px-3 text-sm text-ink placeholder:text-muted/80',
        'outline-none transition-colors duration-150 focus:border-accent/60 focus:ring-2 focus:ring-accent/20',
        'disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}