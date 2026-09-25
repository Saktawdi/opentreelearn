import type { Edge, Node as FlowNode } from '@xyflow/react'
import { messagePreview } from '@/domain/messages'
import type { Id, Message, Node, ReviewCard } from '@/domain/models'
import { isMasteryStale, masteryIndex } from '@/domain/mastery/aggregate'
import { resolveThread } from '@/domain/thread/resolve'
import { DEFAULT_LAYOUT_OPTIONS, computeTreeLayout } from '@/domain/tree/layout'
import { buildTreeIndex } from '@/domain/tree/tree'

export interface LearnNodeData extends Record<string, unknown> {
  nodeId: Id
  title: string
  summary?: string
  excerpt?: string
  /** 摘要正在手动生成中，卡片展示骨架屏而不是旧内容 */
  summarizing: boolean
  messageCount: number
  childCount: number
  /**
   * 「诞生」标记：本画布在场期间新出现的节点，卡片据此播一次「长出来」入场。
   * 由 CanvasPage 在向 flow 注入节点时打（buildGraph 保持纯函数），打开画布
   * 或重新布局都不补标记 —— 动画只解释「刚发生的事」。
   */
  born?: boolean
  forkFromTitle?: string
  selected: boolean
  /** 复习中心（kind: 'review'）：卡片上有专门的标记 */
  reviewCenter: boolean
  /** 子树聚合的掌握度：均值 + 覆盖率（learned/total）；没有掌握度时 score 为 null */
  mastery: { score: number | null; learned: number; total: number } | null
  /** 掌握度快照已过期：摘要之后又学了很久，分数不再代表现状 */
  masteryStale: boolean
  /**
   * 复习卡；没排过卡时不带。
   *
   * 保持率不在这里算：「随分钟衰减」的展示只在**可见卡片**里计算
   * （卡片组件用 `cardRetention` + 下面这个分钟级时钟现算），离屏卡片不参与。
   */
  reviewCard?: ReviewCard
  /** 是否开启保持率热力高亮；默认关闭，避免花哨 */
  showHeatMap?: boolean
  /** 分钟级时钟（见 CanvasPage 的 useDecayClock）；保持率现算的基准 */
  now: number
}

export type LearnFlowNode = FlowNode<LearnNodeData, 'learn' | 'dot'>

export interface GraphResult {
  nodes: LearnFlowNode[]
  edges: Edge[]
}

export interface GraphOptions {
  miniMapMode?: boolean
  summarizingNodeIds?: Id[]
  /** 是否开启热力图着色 */
  showHeatMap?: boolean
  /**
   * 保持率的计算基准时间。调用方按分钟级节流传进来：保持率随时间连续衰减，
   * 没必要每帧重算（见 CanvasPage 的 useDecayClock）。
   */
  now?: number
}

export function buildGraph(
  nodes: Node[],
  messagesByNode: Record<Id, Message[]>,
  selectedNodeId: Id | null,
  options?: GraphOptions,
): GraphResult {
  const isMini = Boolean(options?.miniMapMode)
  const summarizing = new Set(options?.summarizingNodeIds ?? [])
  const now = options?.now ?? Date.now()
  const active = nodes.filter((node) => node.status === 'active')
  const byId = new Map(active.map((node) => [node.id, node]))
  const index = buildTreeIndex(active)
  const aggregates = masteryIndex(active)

  // 当处于微缩点模式（Mini Map）时，节点占位和间距更紧凑
  const layoutOptions = isMini
    ? {
        nodeWidth: 32,
        nodeHeight: 32,
        horizontalGap: 36,
        verticalGap: 48,
      }
    : DEFAULT_LAYOUT_OPTIONS

  const layout = computeTreeLayout(active, layoutOptions)

  const flowNodes: LearnFlowNode[] = active.map((node) => {
    // 卡片摘录与消息数都按显示路径算：历史版本不该出现在卡片上
    const path = resolveThread(node, messagesByNode[node.id] ?? []).path
    const lastAssistant = [...path].reverse().find((message) => message.role === 'assistant')
    const forkSource = node.forkFrom ? byId.get(node.forkFrom.nodeId) : undefined
    const aggregate = aggregates.get(node.id)

    return {
      id: node.id,
      type: isMini ? 'dot' : 'learn',
      position: isMini
        ? layout.positions.get(node.id) ?? { x: 0, y: 0 }
        : node.position ?? layout.positions.get(node.id) ?? { x: 0, y: 0 },
      draggable: !isMini,
      style: {
        width: layoutOptions.nodeWidth,
        height: layoutOptions.nodeHeight,
      },
      data: {
        nodeId: node.id,
        title: node.title,
        summary: node.summary,
        excerpt:
          node.summary ?? (lastAssistant ? messagePreview(lastAssistant, 108) : undefined),
        summarizing: summarizing.has(node.id),
        messageCount: path.length,
        childCount: (index.children.get(node.id) ?? []).length,
        forkFromTitle: forkSource?.title,
        selected: node.id === selectedNodeId,
        reviewCenter: node.kind === 'review',
        mastery: aggregate
          ? { score: aggregate.score, learned: aggregate.learned, total: aggregate.total }
          : null,
        masteryStale: isMasteryStale(node.mastery, node.lastStudiedAt),
        showHeatMap: Boolean(options?.showHeatMap),
        ...(node.review ? { reviewCard: node.review.card } : {}),
        now,
      },
    }
  })

  const edges: Edge[] = []
  for (const node of active) {
    if (node.parentId && byId.has(node.parentId)) {
      edges.push({
        id: `tree-${node.parentId}-${node.id}`,
        source: node.parentId,
        target: node.id,
        type: isMini ? 'smoothstep' : 'smoothstep',
        className: isMini ? 'mini-edge' : undefined,
      })
    }

    const forkNodeId = node.forkFrom?.nodeId
    if (forkNodeId && forkNodeId !== node.parentId && byId.has(forkNodeId)) {
      edges.push({
        id: `fork-${forkNodeId}-${node.id}`,
        source: forkNodeId,
        target: node.id,
        type: 'default',
        className: isMini ? 'mini-edge fork-edge' : 'fork-edge',
      })
    }
  }

  return { nodes: flowNodes, edges }
}