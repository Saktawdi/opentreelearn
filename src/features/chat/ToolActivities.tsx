import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { motion } from 'motion/react'
import { ENTER_FAST } from '@/lib/motion'
/**
 * 工具卡要展示的一行：流式活动与落库的工具记录都归一到这个形状。
 * 放在这里而不是引用 store 的类型，是为了让落库消息也能复用同一份呈现。
 */
export interface ToolActivityItem {
  callId: string
  name: string
  input: unknown
  status: 'running' | 'done' | 'error'
  output?: string
  error?: string
}

/** 工具名的中文标签：没见过的工具名原样显示（不猜、不美化）。 */
function toolLabel(t: TFunction<'chat'>, name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>
  const query = typeof args.query === 'string' ? args.query : ''
  switch (name) {
    case 'list_tools':
      return t('tool.listTools')
    case 'search_nodes':
      return query ? t('tool.searchNodes', { query }) : t('tool.searchNodesPlain')
    case 'get_node':
      return t('tool.getNode')
    case 'get_tree_outline': {
      // 下钻与看全貌是两种动作，卡片上要分得开（用户看的就是这张卡在干什么）
      return typeof args.parentId === 'string'
        ? t('tool.getSubtreeOutline')
        : t('tool.getOutline')
    }
    case 'list_note_labels':
      return t('tool.listLabels')
    case 'search_notes': {
      const labels = Array.isArray(args.labels) ? args.labels.join('、') : ''
      if (labels) return t('tool.searchNotesLabels', { labels })
      return query ? t('tool.searchNotes', { query }) : t('tool.searchNotesPlain')
    }
    case 'update_assessment': {
      const reason = typeof args.reason === 'string' ? args.reason : ''
      return reason ? t('tool.updateAssessmentReason', { reason }) : t('tool.updateAssessment')
    }
    // 写工具：标题、标签这些入参是用户真正要看的（用户批的就是它）
    case 'create_node': {
      const title = typeof args.title === 'string' ? args.title : ''
      return title ? t('tool.createNode', { title }) : t('tool.createNodePlain')
    }
    case 'rename_node': {
      const title = typeof args.title === 'string' ? args.title : ''
      return title ? t('tool.renameNode', { title }) : t('tool.renameNodePlain')
    }
    case 'tag_span': {
      const labels = Array.isArray(args.labels) ? args.labels.join('、') : ''
      return labels ? t('tool.tagSpan', { labels }) : t('tool.tagSpanPlain')
    }
    default:
      return name
  }
}

function statusIcon(status: ToolActivityItem['status']) {
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
  if (status === 'error') return <AlertTriangle className="h-3.5 w-3.5 text-danger" />
  return <Check className="h-3.5 w-3.5 text-success" />
}

/**
 * 流式期间的工具卡：把「正在查什么、查到没有」如实摆出来。
 *
 * 没有它，带工具的轮次会先空屏十几秒（模型在查资料，用户只看得到「正在思考」）。
 * P-A 阶段这些卡片**只在流式期间存在**，不落库 —— 落库的仍然只有正文，
 * 所以「正文里复述关键信息」是硬要求（见 TOOLS_SYSTEM）。
 *
 * 学习对话与自由问答共用这一份：两边的工具是同一批，呈现方式也该一致。
 */
export function ToolActivities({
  tools,
  className,
  animateIn = false,
}: {
  tools: ToolActivityItem[]
  className?: string
  /** 流式期间逐张浮现；落库后随消息整体入场，不再单独动。 */
  animateIn?: boolean
}) {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState<string | null>(null)
  if (tools.length === 0) return null

  return (
    <div className={className ?? 'flex flex-col gap-1'}>
      {tools.map((tool) => {
        const open = expanded === tool.callId
        const detail = tool.error ?? tool.output
        const card = (
          <div
            className="overflow-hidden rounded-lg border border-line/70 bg-elevated/40 text-2xs"
          >
            <button
              type="button"
              disabled={!detail}
              onClick={() => setExpanded(open ? null : tool.callId)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-ink-soft transition-colors enabled:hover:bg-elevated/70 disabled:cursor-default"
            >
              {statusIcon(tool.status)}
              <span className="min-w-0 flex-1 truncate">
                {toolLabel(t, tool.name, tool.input)}
                {tool.status === 'running' ? '…' : ''}
              </span>
              {tool.error ? (
                <span className="shrink-0 text-danger">{t('tool.failed')}</span>
              ) : tool.status === 'done' ? (
                <span className="shrink-0 text-faint">
                  {open ? t('tool.collapse') : t('tool.returned')}
                </span>
              ) : null}
            </button>
            {open && detail ? (
              <pre className="max-h-40 overflow-auto border-t border-line/60 bg-canvas/40 px-2.5 py-1.5 text-2xs whitespace-pre-wrap break-all text-muted">
                {detail}
              </pre>
            ) : null}
          </div>
        )
        // 卡片随 Agent 的进度逐张出现，时间差天然错开，不需要额外 stagger
        return animateIn ? (
          <motion.div
            key={tool.callId}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={ENTER_FAST}
          >
            {card}
          </motion.div>
        ) : (
          <div key={tool.callId}>{card}</div>
        )
      })}
    </div>
  )
}
