import type { Edge, Node as FlowNode } from '@xyflow/react'
import { messagePreview } from '@/domain/messages'
import type { Id, Message, Node } from '@/domain/models'
import { DEFAULT_LAYOUT_OPTIONS, computeTreeLayout } from '@/domain/tree/layout'
import { buildTreeIndex } from '@/domain/tree/tree'

export interface LearnNodeData extends Record<string, unknown> {
  nodeId: Id
  title: string
  summary?: string
  excerpt?: string
  messageCount: number
  childCount: number
  forkFromTitle?: string
  selected: boolean
}

export type LearnFlowNode = FlowNode<LearnNodeData, 'learn'>

export interface GraphResult {
  nodes: LearnFlowNode[]
  edges: Edge[]
}

export function buildGraph(
  nodes: Node[],
  messagesByNode: Record<Id, Message[]>,
  selectedNodeId: Id | null,
): GraphResult {
  const active = nodes.filter((node) => node.status === 'active')
  const byId = new Map(active.map((node) => [node.id, node]))
  const index = buildTreeIndex(active)
  const layout = computeTreeLayout(active)

  const flowNodes: LearnFlowNode[] = active.map((node) => {
    const messages = messagesByNode[node.id] ?? []
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
    const forkSource = node.forkFrom ? byId.get(node.forkFrom.nodeId) : undefined

    return {
      id: node.id,
      type: 'learn',
      position: node.position ?? layout.positions.get(node.id) ?? { x: 0, y: 0 },
      draggable: true,
      style: {
        width: DEFAULT_LAYOUT_OPTIONS.nodeWidth,
        height: DEFAULT_LAYOUT_OPTIONS.nodeHeight,
      },
      data: {
        nodeId: node.id,
        title: node.title,
        summary: node.summary,
        excerpt:
          node.summary ?? (lastAssistant ? messagePreview(lastAssistant, 108) : undefined),
        messageCount: messages.length,
        childCount: (index.children.get(node.id) ?? []).length,
        forkFromTitle: forkSource?.title,
        selected: node.id === selectedNodeId,
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
        type: 'smoothstep',
      })
    }

    const forkNodeId = node.forkFrom?.nodeId
    if (forkNodeId && forkNodeId !== node.parentId && byId.has(forkNodeId)) {
      edges.push({
        id: `fork-${forkNodeId}-${node.id}`,
        source: forkNodeId,
        target: node.id,
        type: 'default',
        className: 'fork-edge',
      })
    }
  }

  return { nodes: flowNodes, edges }
}