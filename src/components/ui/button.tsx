import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium outline-none transition-[background-color,border-color,color,opacity] duration-150 disabled:pointer-events-none disabled:opacity-45 focus-visible:ring-2 focus-visible:ring-accent/45',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-ink hover:bg-accent/88',
        secondary: 'border border-line bg-elevated text-ink hover:border-line-strong hover:bg-line/55',
        ghost: 'text-ink-soft hover:bg-elevated hover:text-ink',
        subtle: 'bg-line/45 text-ink-soft hover:bg-line/70 hover:text-ink',
        danger: 'border border-danger/35 bg-danger-soft text-danger hover:border-danger/70',
        link: 'text-accent underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs',
        md: 'h-8 px-3',
        lg: 'h-9 px-4',
        icon: 'h-8 w-8',
        'icon-sm': 'h-7 w-7',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
    },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button'
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />
}