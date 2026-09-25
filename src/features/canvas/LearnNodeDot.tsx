import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo } from 'react'
import { Tooltip } from '@/components/ui/tooltip'
import { cardHeat } from '@/domain/review/schedule'
import { cn } from '@/lib/utils'
import type { LearnFlowNode } from './graph'

export const LearnNodeDot = memo(function LearnNodeDot({ data }: NodeProps<LearnFlowNode>) {
  const isSelected = data.selected
  const isReviewCenter = data.reviewCenter
  // 微缩地图也吃热力图：只有在开启热力图视图时变色，其余时刻保持整洁的选中态区分
  const heat = data.reviewCard && data.showHeatMap ? cardHeat(data.reviewCard, data.now) : 'none'
  const tooltipText = isReviewCenter
    ? `${data.title || '复习中心'} · 复习中心`
    : heat === 'none'
      ? data.title || '未命名节点'
      : `${data.title || '未命名节点'} · ${heat === 'hot' ? '快忘了' : '该复习'}`

  return (
    <Tooltip label={tooltipText} side="left">
      <div
        className={cn(
          'group relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-full transition-transform duration-150',
          isSelected
            ? isReviewCenter
              ? 'ring-2 ring-info ring-offset-2 ring-offset-canvas'
              : 'ring-2 ring-accent ring-offset-2 ring-offset-canvas'
            : 'hover:scale-110',
        )}
      >
        <Handle type="target" position={Position.Top} className="opacity-0" isConnectable={false} />
        <Handle type="source" position={Position.Bottom} className="opacity-0" isConnectable={false} />

        {/* 外环圆圈 */}
        <div
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-full border transition-colors',
            isSelected
              ? isReviewCenter
                ? 'border-info bg-info/20'
                : 'border-accent bg-accent/15'
              : isReviewCenter
                ? 'border-info/50 bg-info/10 hover:border-info hover:bg-info/15'
                : heat === 'hot'
                  ? 'border-danger/60 bg-danger-soft'
                  : heat === 'warm'
                    ? 'border-accent/50 bg-accent-soft'
                    : 'border-line-strong bg-surface hover:border-accent/60 hover:bg-elevated',
          )}
        >
          {/* 内芯圆点：有没有子节点用「大小」编码——28px 尺寸下亮度差低于可感知阈值 */}
          <div
            className={cn(
              'rounded-full transition-all',
              data.childCount > 0 ? 'h-2.5 w-2.5' : 'h-1.5 w-1.5',
              isSelected
                ? isReviewCenter
                  ? 'bg-info'
                  : 'bg-accent'
                : isReviewCenter
                  ? 'bg-info'
                  : heat === 'hot'
                    ? 'bg-danger'
                    : heat === 'warm'
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
