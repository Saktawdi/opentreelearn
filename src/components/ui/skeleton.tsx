import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** 内容占位骨架：等待生成/加载时用它撑住位置，避免布局跳动。 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-sm bg-line/70', className)}
      {...props}
    />
  )
}