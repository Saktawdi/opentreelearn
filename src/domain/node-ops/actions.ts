import type { ParseKeys } from 'i18next'
import i18n from '@/i18n'
import type { ForkRef, Id, Node } from '@/domain/models'
import { newId } from '@/lib/id'

export type NodeActionKind = 'diverge' | 'child' | 'branch'

/**
 * 节点操作提示语的 i18n 键（渲染处用 t() 解析为当前语言）。
 * 消费方：FocusChatView 的菜单（chat 命名空间）、CanvasContextMenu（canvas 命名空间）。
 */
export const NODE_ACTION_HINT_KEY: Record<NodeActionKind, ParseKeys<'common'>> = {
  diverge: 'hint.diverge',
  child: 'hint.child',
  branch: 'hint.branch',
}

export interface CreateNodeParams {
  projectId: Id
  sourceNode: Node
  kind: NodeActionKind
  sourceMessageId?: Id
  title?: string
  id?: Id
  now?: number
}

export function resolveParentId(kind: NodeActionKind, sourceNode: Node): Id | null {
  return kind === 'diverge' ? sourceNode.parentId : sourceNode.id
}

export function resolveForkFrom(
  kind: NodeActionKind,
  sourceNode: Node,
  sourceMessageId?: Id,
): ForkRef | null {
  if (kind === 'child') return null
  if (!sourceMessageId) return null
  // 冻结源节点 fork 时的版本选择：源节点之后切版本不会悄悄改写这个子节点的上下文
  const selection = sourceNode.thread?.selection
  return {
    nodeId: sourceNode.id,
    messageId: sourceMessageId,
    ...(selection && Object.keys(selection).length > 0 ? { selection: { ...selection } } : {}),
  }
}

export function createNodeFromAction(params: CreateNodeParams): Node {
  const timestamp = params.now ?? Date.now()
  return {
    id: params.id ?? newId(),
    projectId: params.projectId,
    parentId: resolveParentId(params.kind, params.sourceNode),
    forkFrom: resolveForkFrom(params.kind, params.sourceNode, params.sourceMessageId),
    title: params.title ?? i18n.t('common:fallback.newNodeTitle'),
    position: null,
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

export function nodeActionRequiresMessage(kind: NodeActionKind): boolean {
  return kind !== 'child'
}

export function describeFork(node: Node, messages: { id: Id; preview: string }[]): string | null {
  if (!node.forkFrom) return null
  const source = messages.find((message) => message.id === node.forkFrom?.messageId)
  return source ? source.preview : null
}