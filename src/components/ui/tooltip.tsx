import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={280} skipDelayDuration={120}>
      {children}
    </TooltipPrimitive.Provider>
  )
}

export function Tooltip({
  label,
  children,
  side = 'bottom',
}: {
  label: ReactNode
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
}) {
  // 约束：children 的 className 必须是字符串常量。radix Slot 合并 className 走的是
  // `[slotProp, childProp].filter(Boolean).join(' ')`，函数式 className（例如 NavLink
  // 的 render prop 写法）会被 String() 成源码文本写进 class 属性，子元素随之丢掉自己的
  // 定位类（`relative` 失效 → 内部绝对定位元素改以整页为基准）。需要按路由状态改样式
  // 时，className 保持常量，把状态相关类下移到内层元素。
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="pop-panel z-50 rounded-md border border-line bg-elevated px-2 py-1 text-xs text-ink-soft shadow-panel"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}