import { Handle, Position, type NodeProps } from '@xyflow/react'
import { GitBranch, MessageSquare, Waypoints } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { LearnFlowNode } from './graph'

export function LearnNodeCard({ data }: NodeProps<LearnFlowNode>) {
  const hasExcerpt = Boolean(data.excerpt)

  return (
    <div
      className={cn(
        'group relative flex h-full w-full cursor-pointer flex-col rounded-lg border bg-surface p-3 text-left transition-colors duration-150',
        data.selected
          ? 'border-accent/60 bg-elevated'
          : 'border-line hover:border-line-strong hover:bg-elevated',
      )}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />

      <div className="flex items-start gap-2">
        <span
          className={cn(
            'mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full',
            data.selected ? 'bg-accent' : 'bg-line-strong group-hover:bg-muted',
          )}
        />
        <h3 className="line-clamp-2 text-sm font-medium leading-snug text-ink">{data.title}</h3>
      </div>

      {data.summarizing ? (
        <div className="mt-1.5 flex flex-1 flex-col gap-1.5" aria-label="正在生成摘要">
          <Skeleton className="h-2.5 w-full" />
          <Skeleton className="h-2.5 w-3/5" />
        </div>
      ) : (
        <p
          className={cn(
            'mt-1.5 line-clamp-2 flex-1 text-xs leading-relaxed',
            hasExcerpt ? 'text-muted' : 'text-faint',
          )}
        >
          {data.excerpt ?? '还没有对话'}
        </p>
      )}

      <div className="mt-2 flex items-center gap-2.5 text-2xs text-muted">
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="h-3 w-3" />
          {data.messageCount}
        </span>
        {data.childCount > 0 ? (
          <span className="inline-flex items-center gap-1">
            <Waypoints className="h-3 w-3" />
            {data.childCount}
          </span>
        ) : null}
        {data.forkFromTitle ? (
          <Tooltip label={`上下文继承自《${data.forkFromTitle}》`}>
            <span className="inline-flex items-center gap-1 text-accent/85">
              <GitBranch className="h-2.5 w-2.5" />
              继承
            </span>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}