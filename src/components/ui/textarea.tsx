import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          'w-full resize-y rounded-md border border-line bg-canvas/60 px-2.5 py-2 text-sm leading-relaxed text-ink placeholder:text-faint',
          'outline-none transition-colors duration-150 focus:border-accent/60 focus:ring-2 focus:ring-accent/20',
          'disabled:opacity-50',
          className,
        )}
        {...props}
      />
    )
  },
)