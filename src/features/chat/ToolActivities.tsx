import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { useState } from 'react'
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
function toolLabel(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>
  const query = typeof args.query === 'string' ? args.query : ''
  switch (name) {
    case 'search_nodes':
      return query ? `查询节点「${query}」` : '查询节点'
    case 'get_node':
      return '查看节点详情'
    case 'get_tree_outline':
      return '查看树大纲'
    case 'list_note_labels':
      return '统计标注标签'
    case 'search_notes': {
      const labels = Array.isArray(args.labels) ? args.labels.join('、') : ''
      if (labels) return `检索标注（${labels}）`
      return query ? `检索标注「${query}」` : '检索标注'
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
}: {
  tools: ToolActivityItem[]
  className?: string
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  if (tools.length === 0) return null

  return (
    <div className={className ?? 'flex flex-col gap-1'}>
      {tools.map((tool) => {
        const open = expanded === tool.callId
        const detail = tool.error ?? tool.output
        return (
          <div
            key={tool.callId}
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
                {toolLabel(tool.name, tool.input)}
                {tool.status === 'running' ? '…' : ''}
              </span>
              {tool.error ? (
                <span className="shrink-0 text-danger">失败</span>
              ) : tool.status === 'done' ? (
                <span className="shrink-0 text-faint">{open ? '收起' : '已返回'}</span>
              ) : null}
            </button>
            {open && detail ? (
              <pre className="max-h-40 overflow-auto border-t border-line/60 bg-canvas/40 px-2.5 py-1.5 text-2xs whitespace-pre-wrap break-all text-muted">
                {detail}
              </pre>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}