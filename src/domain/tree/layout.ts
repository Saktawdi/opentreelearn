import { hierarchy, tree } from 'd3-hierarchy'
import type { Id, Node } from '@/domain/models'
import { activeNodes, buildTreeIndex, collectReachable, rootNodes, type TreeIndex } from './tree'

export interface LayoutOptions {
  nodeWidth: number
  nodeHeight: number
  hGap: number
  vGap: number
  treeGap: number
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  nodeWidth: 268,
  nodeHeight: 112,
  hGap: 40,
  vGap: 84,
  treeGap: 120,
}

export interface LayoutResult {
  positions: Map<Id, { x: number; y: number }>
  width: number
  height: number
}

interface LayoutDatum {
  id: Id
  children: LayoutDatum[]
}

function toLayoutDatum(node: Node, index: TreeIndex, seen: Set<Id>): LayoutDatum {
  seen.add(node.id)
  const children = (index.children.get(node.id) ?? [])
    .filter((child) => !seen.has(child.id))
    .map((child) => toLayoutDatum(child, index, seen))
  return { id: node.id, children }
}

export function computeTreeLayout(
  nodes: Node[],
  options: Partial<LayoutOptions> = {},
): LayoutResult {
  const opts: LayoutOptions = { ...DEFAULT_LAYOUT_OPTIONS, ...options }
  const visible = activeNodes(nodes)
  const index = buildTreeIndex(visible)
  const positions = new Map<Id, { x: number; y: number }>()

  const layout = tree<LayoutDatum>()
    .nodeSize([opts.nodeWidth + opts.hGap, opts.nodeHeight + opts.vGap])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.3))

  let cursorX = 0
  let maxY = 0

  for (const root of rootNodes(index)) {
    const layoutRoot = hierarchy(toLayoutDatum(root, index, new Set()))
    layout(layoutRoot)

    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let treeMaxY = 0

    layoutRoot.each((point) => {
      const x = point.x ?? 0
      const y = point.y ?? 0
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      treeMaxY = Math.max(treeMaxY, y)
    })

    if (!Number.isFinite(minX)) {
      minX = 0
      maxX = 0
    }

    const offsetX = cursorX - minX
    layoutRoot.each((point) => {
      positions.set(point.data.id, {
        x: Math.round((point.x ?? 0) + offsetX - opts.nodeWidth / 2),
        y: Math.round(point.y ?? 0),
      })
    })

    cursorX += maxX - minX + opts.nodeWidth + opts.treeGap
    maxY = Math.max(maxY, treeMaxY)
  }

  const reachable = collectReachable(index)
  const strays = visible.filter((node) => !reachable.has(node.id))
  strays.forEach((node, i) => {
    positions.set(node.id, {
      x: Math.round(cursorX + i * (opts.nodeWidth + opts.hGap)),
      y: 0,
    })
  })
  if (strays.length > 0) {
    cursorX += strays.length * (opts.nodeWidth + opts.hGap)
  }

  return {
    positions,
    width: Math.max(cursorX - opts.treeGap, opts.nodeWidth),
    height: Math.max(maxY + opts.nodeHeight, opts.nodeHeight),
  }
}