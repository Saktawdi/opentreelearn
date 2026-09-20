import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo } from 'react'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { LearnFlowNode } from './graph'

export const LearnNodeDot = memo(function LearnNodeDot({ data }: NodeProps<LearnFlowNode>) {
  const isSelected = data.selected
  const tooltipText = data.title || '未命名节点'

  return (
    <Tooltip label={tooltipText} side="left">
      <div
        className={cn(
          'group relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-full transition-transform duration-150',
          isSelected ? 'ring-2 ring-accent ring-offset-2 ring-offset-canvas' : 'hover:scale-110',
        )}
      >
        <Handle type="target" position={Position.Top} className="opacity-0" isConnectable={false} />
        <Handle type="source" position={Position.Bottom} className="opacity-0" isConnectable={false} />

        {/* 外环圆圈 */}
        <div
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-full border transition-colors',
            isSelected
              ? 'border-accent bg-accent/15'
              : 'border-line-strong bg-surface hover:border-accent/60 hover:bg-elevated',
          )}
        >
          {/* 内芯圆点 */}
          <div
            className={cn(
              'h-2.5 w-2.5 rounded-full transition-colors',
              isSelected
                ? 'bg-accent'
                : data.childCount > 0
                  ? 'bg-ink-soft group-hover:bg-accent'
                  : 'bg-faint group-hover:bg-ink-soft',
            )}
          />
        </div>
      </div>
    </Tooltip>
  )
})
