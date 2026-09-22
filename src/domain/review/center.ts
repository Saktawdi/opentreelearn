import type { Id, Node } from '@/domain/models'
import { newId } from '@/lib/id'
import { buildTreeIndex } from '@/domain/tree/tree'

/**
 * 复习中心节点：旧实现（T-128 之前）的承载方式，本期起**不再创建**。
 *
 * 它曾经是「今天该复习什么」的对话与队列的落点，因此可能含有用户真实的学习对话、
 * 笔记与子节点。新流程不再使用它，但**绝不删除、不自动归档、不转换成别的节点** ——
 * 只做兼容读取：
 *
 * 1. 常规学习树与节点计数里不再出现中心节点本身；
 * 2. 挂在它下面的**普通学习后代**必须继续可见可学：投影时跳过隐藏的中心祖先，
 *    把后代重新挂到最近的可见祖先上（只影响视图，不批量改写 `parentId`）；
 * 3. 它的历史内容通过「旧复习中心记录」入口只读浏览。
 */

export const REVIEW_CENTER_TITLE = '复习中心'

/** 旧复习中心：包含归档的（历史内容仍要能查看）。 */
export function legacyReviewCenters(nodes: Node[]): Node[] {
  return nodes.filter((node) => node.kind === 'review')
}

/** 活跃的旧复习中心；每个项目至多一个（历史数据可能更多，取最早创建的那个）。 */
export function findReviewCenter(nodes: Node[]): Node | null {
  const centers = legacyReviewCenters(nodes)
    .filter((node) => node.status === 'active')
    .sort((a, b) => a.createdAt - b.createdAt)
  return centers[0] ?? null
}

export function isLegacyCenter(node: Node): boolean {
  return node.kind === 'review'
}

/**
 * 学习树投影：去掉隐藏的旧中心，并把它们的后代接回最近的可见祖先。
 *
 * 只返回**发生了变化**的节点的新对象，其余原样引用 —— 画布每帧都在遍历这些数组，
 * 没必要全量拷贝。不修改入参，也不写回存储：隐藏是视图行为，`parentId` 仍是用户
 * 数据的真实结构。
 */
export function projectVisibleNodes(nodes: Node[]): Node[] {
  const index = buildTreeIndex(nodes)
  const visibleParentOf = (node: Node): Id | null => {
    let cursor = node.parentId ? index.byId.get(node.parentId) : undefined
    const seen = new Set<Id>([node.id])
    while (cursor) {
      if (seen.has(cursor.id)) return null
      seen.add(cursor.id)
      if (!isLegacyCenter(cursor)) return cursor.id
      cursor = cursor.parentId ? index.byId.get(cursor.parentId) : undefined
    }
    return null
  }

  const result: Node[] = []
  for (const node of nodes) {
    if (isLegacyCenter(node)) continue
    const nextParent = node.parentId && index.byId.has(node.parentId) ? visibleParentOf(node) : null
    result.push(nextParent === node.parentId ? node : { ...node, parentId: nextParent })
  }
  return result
}

/** 视图投影是否改变过任何父子关系（父节点是隐藏中心时才需要）。 */
export function hasHiddenAncestor(node: Node, nodes: Node[]): boolean {
  const index = buildTreeIndex(nodes)
  const seen = new Set<Id>([node.id])
  let cursor = node.parentId ? index.byId.get(node.parentId) : undefined
  while (cursor) {
    if (seen.has(cursor.id)) return false
    seen.add(cursor.id)
    if (isLegacyCenter(cursor)) return true
    cursor = cursor.parentId ? index.byId.get(cursor.parentId) : undefined
  }
  return false
}

export interface CreateReviewCenterParams {
  projectId: Id
  id?: Id
  now?: number
}

/**
 * 建一个复习中心节点。
 *
 * 本期已无调用方（新入口是项目复习工作区），保留它是为了测试夹具与将来的数据修复脚本，
 * 不是为了在新流程里复活这个节点类型。
 */
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