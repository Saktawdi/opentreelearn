import type { Id, Node } from '@/domain/models'

export interface TreeIndex {
  byId: Map<Id, Node>
  children: Map<Id | null, Node[]>
}

export function buildTreeIndex(nodes: Node[]): TreeIndex {
  const byId = new Map<Id, Node>()
  for (const node of nodes) {
    byId.set(node.id, node)
  }

  const children = new Map<Id | null, Node[]>()
  for (const node of nodes) {
    const parentKey = node.parentId && byId.has(node.parentId) ? node.parentId : null
    const siblings = children.get(parentKey)
    if (siblings) {
      siblings.push(node)
    } else {
      children.set(parentKey, [node])
    }
  }

  for (const list of children.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt)
  }

  return { byId, children }
}

export function activeNodes(nodes: Node[]): Node[] {
  return nodes.filter((node) => node.status === 'active')
}

export function rootNodes(index: TreeIndex): Node[] {
  return index.children.get(null) ?? []
}

export function childrenOf(index: TreeIndex, id: Id): Node[] {
  return index.children.get(id) ?? []
}

export function parentOf(index: TreeIndex, id: Id): Node | null {
  const node = index.byId.get(id)
  if (!node?.parentId) return null
  return index.byId.get(node.parentId) ?? null
}

export function pathTo(index: TreeIndex, id: Id): Node[] {
  const path: Node[] = []
  const seen = new Set<Id>()
  let cursor = index.byId.get(id)
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    path.unshift(cursor)
    cursor = cursor.parentId ? index.byId.get(cursor.parentId) : undefined
  }
  return path
}

export function ancestorsOf(index: TreeIndex, id: Id): Node[] {
  return pathTo(index, id).slice(0, -1)
}

export function depthOf(index: TreeIndex, id: Id): number {
  return Math.max(pathTo(index, id).length - 1, 0)
}

export function descendantsOf(index: TreeIndex, id: Id): Node[] {
  const result: Node[] = []
  const stack = [...childrenOf(index, id)]
  const seen = new Set<Id>()
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node || seen.has(node.id)) continue
    seen.add(node.id)
    result.push(node)
    stack.push(...childrenOf(index, node.id))
  }
  return result
}

export function subtreeSize(index: TreeIndex, id: Id): number {
  return descendantsOf(index, id).length
}

export function forkedChildrenOf(nodes: Node[], id: Id): Node[] {
  return nodes.filter((node) => node.forkFrom?.nodeId === id)
}

export function collectReachable(index: TreeIndex): Set<Id> {
  const reachable = new Set<Id>()
  const stack = [...rootNodes(index)]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node || reachable.has(node.id)) continue
    reachable.add(node.id)
    stack.push(...childrenOf(index, node.id))
  }
  return reachable
}