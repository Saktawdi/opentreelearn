import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ComponentProps, HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { showClose?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/65 backdrop-blur-[2px]" />
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
        <DialogPrimitive.Content
          className={cn(
            'dialog-panel pointer-events-auto relative w-[min(560px,100%)] rounded-2xl border border-line bg-surface p-5 shadow-panel outline-none',
            className,
          )}
          {...props}
        >
          {children}
          {showClose ? (
            <DialogPrimitive.Close className="absolute right-3.5 top-3.5 rounded-md p-1 text-muted transition-colors hover:bg-elevated hover:text-ink">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          ) : null}
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Portal>
  )
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 space-y-1.5 pr-8', className)} {...props} />
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mt-5 flex items-center justify-end gap-2', className)}
      {...props}
    />
  )
}

export function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-[15px] font-semibold text-ink', className)}
      {...props}
    />
  )
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-[13px] leading-relaxed text-muted', className)}
      {...props}
    />
  )
}

export function DialogField({
  label,
  children,
  hint,
}: {
  label: ReactNode
  children: ReactNode
  hint?: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-[13px] font-medium text-ink-soft">{label}</span>
      {children}
      {hint ? <p className="text-[12px] leading-relaxed text-muted">{hint}</p> : null}
    </div>
  )
}