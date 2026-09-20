import { Handle, Position, type NodeProps } from '@xyflow/react'
import { GitBranch, MessageSquare, Waypoints } from 'lucide-react'
import { motion } from 'motion/react'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { LearnFlowNode } from './graph'

export function LearnNodeCard({ data }: NodeProps<LearnFlowNode>) {
  const hasExcerpt = Boolean(data.excerpt)

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'group relative flex h-full w-full cursor-pointer flex-col rounded-xl border bg-surface p-3 text-left shadow-node transition-[border-color,background-color,box-shadow] duration-200',
        data.selected
          ? 'border-accent/60 bg-elevated ring-1 ring-accent/20'
          : 'border-line hover:border-line-strong hover:bg-elevated',
      )}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />

      <div className="flex items-start gap-2">
        <span
          className={cn(
            'mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full transition-colors',
            data.selected ? 'bg-accent' : 'bg-line-strong group-hover:bg-muted',
          )}
        />
        <h3 className="line-clamp-2 text-[13px] font-medium leading-snug text-ink">{data.title}</h3>
      </div>

      <p
        className={cn(
          'mt-1.5 line-clamp-2 flex-1 text-[11.5px] leading-relaxed',
          hasExcerpt ? 'text-muted' : 'text-muted/50',
        )}
      >
        {data.excerpt ?? '还没有对话，点开开始提问。'}
      </p>

      <div className="mt-2 flex items-center gap-2.5 text-[10.5px] text-muted/80">
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
            <span className="inline-flex items-center gap-1 rounded border border-dashed border-accent/40 px-1 py-[1px] text-accent/85">
              <GitBranch className="h-2.5 w-2.5" />
              继承
            </span>
          </Tooltip>
        ) : null}
      </div>
    </motion.div>
  )
}