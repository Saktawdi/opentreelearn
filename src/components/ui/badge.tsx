import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs font-medium leading-4',
  {
    variants: {
      tone: {
        neutral: 'border-line bg-elevated text-muted',
        accent: 'border-accent/35 bg-accent-soft text-accent',
        danger: 'border-danger/35 bg-danger-soft text-danger',
        success: 'border-success/30 bg-success/10 text-success',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  },
)

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}