import type { ForkRef, Id, Node } from '@/domain/models'
import { newId } from '@/lib/id'

export type NodeActionKind = 'diverge' | 'child' | 'branch'

export const NODE_ACTION_LABEL: Record<NodeActionKind, string> = {
  diverge: '发散节点',
  child: '子节点',
  branch: '分支节点',
}

export const NODE_ACTION_HINT: Record<NodeActionKind, string> = {
  diverge: '在当前节点横向新建，并继承这段对话的上下文',
  child: '在当前节点下方新建空白节点，只注入个人背景',
  branch: '在当前节点下方新建，并继承这段对话的上下文',
}

export const PLACEHOLDER_TITLE = '新节点'

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
    title: params.title ?? PLACEHOLDER_TITLE,
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