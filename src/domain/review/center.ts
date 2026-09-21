import type { Id, Node } from '@/domain/models'
import { newId } from '@/lib/id'

/**
 * 复习中心节点：每个项目至多一个，自成一棵根树。
 *
 * 它是**元数据节点**：没有学习内容、不参与掌握度聚合、也不进复习池，
 * 承载的是「今天该复习什么」的对话与队列。
 */

export const REVIEW_CENTER_TITLE = '复习中心'

export function findReviewCenter(nodes: Node[]): Node | null {
  return (
    nodes.find((node) => node.kind === 'review' && node.status === 'active') ?? null
  )
}

export interface CreateReviewCenterParams {
  projectId: Id
  id?: Id
  now?: number
}

export function createReviewCenterNode(params: CreateReviewCenterParams): Node {
  const now = params.now ?? Date.now()
  return {
    id: params.id ?? newId(),
    projectId: params.projectId,
    parentId: null,
    forkFrom: null,
    title: REVIEW_CENTER_TITLE,
    position: null,
    status: 'active',
    kind: 'review',
    createdAt: now,
    updatedAt: now,
  }
}