import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Brain, GitBranch, MessageSquare, RefreshCcw, Waypoints } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/ui/tooltip'
import {
  cardHeat,
  cardRetention,
  GRADE_BAND_LABEL,
  gradeOfScore,
  type HeatLevel,
} from '@/domain/review/schedule'
import { cn } from '@/lib/utils'
import type { LearnFlowNode } from './graph'

/** 热力档位的边框与角标配色；`none` 时保持中性。 */
const HEAT_STYLES: Record<HeatLevel, { border: string; badge: string }> = {
  none: { border: '', badge: '' },
  // 琥珀用主题里的 accent（就是这个色），红色用 danger，不新增色板
  warm: { border: 'border-accent/45', badge: 'border-accent/40 bg-accent-soft text-accent' },
  hot: { border: 'border-danger/55', badge: 'border-danger/40 bg-danger-soft text-danger' },
}

/**
 * 保持率热力角标：只在有卡片、且确实该提醒时出现（否则又是一堆装饰）。
 *
 * 保持率在**卡片渲染时**用分钟级时钟现算：离屏卡片根本不会渲染（详情画布开了
 * `onlyRenderVisibleElements`），所以「仅可见卡片计算」是自然满足的。
 */
function HeatBadge({ data }: { data: LearnFlowNode['data'] }) {
  if (!data.reviewCard) return null
  const heat = cardHeat(data.reviewCard, data.now)
  if (heat === 'none') return null
  const retention = cardRetention(data.reviewCard, data.now)

  return (
    <Tooltip label={`保持率约 ${Math.round(retention * 100)}%，该复习了`}>
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs',
          HEAT_STYLES[heat].badge,
        )}
      >
        <RefreshCcw className="h-2.5 w-2.5" />
        {heat === 'hot' ? '快忘了' : '该复习'}
      </span>
    </Tooltip>
  )
}

/** 卡片底部的掌握度：子树均值 + 覆盖率；过期时弱化并说明原因。 */
function MasteryLine({ data }: { data: LearnFlowNode['data'] }) {
  const mastery = data.mastery
  if (!mastery || mastery.total === 0) return null

  if (mastery.score === null) {
    return (
      <Tooltip label={`子树里还没有节点生成过掌握度评估（0/${mastery.total}）`}>
        <span className="inline-flex items-center gap-1 text-2xs text-faint">
          <Brain className="h-3 w-3" />
          掌握 — · 0/{mastery.total}
        </span>
      </Tooltip>
    )
  }

  const band = GRADE_BAND_LABEL[gradeOfScore(mastery.score)]

  return (
    <Tooltip
      label={
        data.masteryStale
          ? '摘要生成后又继续学习过，这个分数可能已经过期'
          : `掌握度 ${mastery.score} · 子树 ${mastery.learned}/${mastery.total} 个节点已评估 · 档位 ${band}（${gradeOfScore(mastery.score)}）`
      }
    >
      <span
        className={cn(
          'inline-flex items-center gap-1 text-2xs',
          data.masteryStale ? 'text-faint' : 'text-ink-soft',
        )}
      >
        <Brain className={cn('h-3 w-3', data.masteryStale && 'opacity-60')} />
        <span className={cn('tabular-nums', data.masteryStale && 'line-through')}>
          掌握 {mastery.score}
        </span>
        <span className="text-faint">
          · {mastery.learned}/{mastery.total}
        </span>
      </span>
    </Tooltip>
  )
}

export function LearnNodeCard({ data }: NodeProps<LearnFlowNode>) {
  const hasExcerpt = Boolean(data.excerpt)
  const heat = data.reviewCard ? HEAT_STYLES[cardHeat(data.reviewCard, data.now)].border : ''

  return (
    <div
      className={cn(
        'group relative flex h-full w-full cursor-pointer flex-col rounded-lg border bg-surface p-3 text-left transition-colors duration-150',
        data.selected
          ? 'border-accent/60 bg-elevated'
          : cn('border-line hover:border-line-strong hover:bg-elevated', heat),
      )}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />

      <div className="flex items-start gap-2">
        <span
          className={cn(
            'mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full',
            data.reviewCenter
              ? 'bg-info'
              : data.selected
                ? 'bg-accent'
                : 'bg-line-strong group-hover:bg-muted',
          )}
        />
        <h3 className="line-clamp-2 text-sm font-medium leading-snug text-ink">{data.title}</h3>
        {data.reviewCenter ? (
          <span className="ml-auto shrink-0 rounded-full border border-info/40 bg-info/10 px-1.5 py-0.5 text-2xs text-info">
            复习中心
          </span>
        ) : null}
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

      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-muted">
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
        <HeatBadge data={data} />
        <MasteryLine data={data} />
      </div>
    </div>
  )
}
