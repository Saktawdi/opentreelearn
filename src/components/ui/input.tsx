import type { InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-md border border-line bg-canvas/60 px-2.5 text-sm text-ink placeholder:text-faint',
        'outline-none transition-colors duration-150 focus:border-accent/60 focus:ring-2 focus:ring-accent/20',
        'disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}