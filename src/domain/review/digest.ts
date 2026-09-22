import type { Id, Node, ReviewGrade } from '@/domain/models'
import { buildTreeIndex } from '@/domain/tree/tree'
import { isDueForReview } from './enrollment'
import { dueAt, gradeOfScore, isRelearning, retentionOf, startOfDay } from './schedule'

/**
 * 学习快照（digest）：复习中心的上下文来源。
 *
 * 它是**纯函数、每次发送时重算**：不冻结一份「上次的快照」，因为掌握度、
 * 保持率、到期状态本来就会随着时间与学习动作变化，冻结等于给模型看旧地图。
 *
 * 每主题一行：掌握档位 / 上次学习 / 保持率 / 薄弱点。树的结构用缩进表达 ——
 * 这是相对卡片类应用独有的信息（一个主题挂在哪个主题下面）。
 */

const DAY_MS = 24 * 60 * 60 * 1000

export interface StudyDigestEntry {
  nodeId: Id
  title: string
  /** 树的层级，0 = 根 */
  depth: number
  /** 掌握档位；没有掌握度时为 null（不是 0 分） */
  band: ReviewGrade | null
  /** 上次学习距今天数；从未学习为 null */
  studiedDaysAgo: number | null
  /** 当前保持率（0-1）；没有卡片为 null */
  retention: number | null
  weakPoints: string[]
  due: boolean
  relearn: boolean
}

export interface StudyDigest {
  entries: StudyDigestEntry[]
  /** 因超出 limit 而未列出的主题数 */
  omitted: number
  total: number
}

export interface DigestOptions {
  now: number
  /** 最多列出多少个主题；超出时优先保留「更该被看到」的那些 */
  limit?: number
}

const DEFAULT_DIGEST_LIMIT = 40

function daysAgo(now: number, timestamp: number): number {
  return Math.max(0, Math.round((startOfDay(now) - startOfDay(timestamp)) / DAY_MS))
}

/**
 * 按树的顺序（父 → 子，同级按创建时间）深度优先展开，缩进即结构。
 *
 * 复习中心的自由问答清单也用这个顺序（`domain/context/free-ask`）：两处的层级
 * 读法必须一致，否则模型在同一份上下文里会看到两种结构。
 */
export function treeOrder(nodes: Node[]): Array<{ node: Node; depth: number }> {
  const index = buildTreeIndex(nodes)
  const ordered: Array<{ node: Node; depth: number }> = []
  const seen = new Set<Id>()

  const walk = (node: Node, depth: number): void => {
    if (seen.has(node.id)) return
    seen.add(node.id)
    ordered.push({ node, depth })
    for (const child of index.children.get(node.id) ?? []) walk(child, depth + 1)
  }

  // 从各棵树的根往下走。父节点被归档 / 不在列表里的活跃节点由 buildTreeIndex
  // 挂到根桶（`parentKey` 取不到就归 null），所以这里已经覆盖孤儿与断链
  for (const root of index.children.get(null) ?? []) walk(root, 0)

  // 兜底：环里的节点（父子互指、自己指自己）从任何根都走不到，但它们是活跃的、
  // 也可能带着掌握度。宁可平铺在最外层，也不能让快照静默吞掉一颗子树。
  for (const node of nodes) walk(node, 0)
  return ordered
}

/** 超出上限时的取舍：先看到期的、再看不熟到熟的；复习中心与归档节点不参与。 */
function urgency(entry: StudyDigestEntry): number {
  if (entry.due) return -1
  return entry.retention ?? 0
}

export function buildStudyDigest(nodes: Node[], options: DigestOptions): StudyDigest {
  const now = options.now
  const limit = options.limit ?? DEFAULT_DIGEST_LIMIT

  const active = nodes.filter((node) => node.status === 'active' && node.kind !== 'review')
  const ordered = treeOrder(active)

  const all: StudyDigestEntry[] = ordered.map(({ node, depth }) => {
    const score = node.mastery?.score
    return {
      nodeId: node.id,
      title: node.title,
      depth,
      band: score === undefined ? null : gradeOfScore(score),
      studiedDaysAgo: node.lastStudiedAt === undefined ? null : daysAgo(now, node.lastStudiedAt),
      retention: retentionOf(node, now),
      weakPoints: node.mastery?.weakPoints ?? [],
      due: isDueForReview(node, now),
      relearn: isRelearning(node),
    }
  })

  if (all.length <= limit) return { entries: all, omitted: 0, total: all.length }

  // 超限：挑出最该被看到的 limit 条，再按树序还原顺序，缩进才读得通
  const selectedIds = new Set(
    [...all]
      .sort((a, b) => urgency(a) - urgency(b))
      .slice(0, limit)
      .map((entry) => entry.nodeId),
  )
  const entries = all.filter((entry) => selectedIds.has(entry.nodeId))
  return { entries, omitted: all.length - entries.length, total: all.length }
}

function formatRetention(retention: number | null): string {
  return retention === null ? '保持率未知' : `保持率 ${Math.round(retention * 100)}%`
}

function formatStudied(days: number | null): string {
  if (days === null) return '尚未学习'
  if (days === 0) return '今天学过'
  return `${days} 天前学习`
}

function renderEntry(entry: StudyDigestEntry): string {
  const indent = '  '.repeat(entry.depth)
  const parts = [
    entry.band === null ? '未评估' : `档位 ${entry.band}`,
    formatStudied(entry.studiedDaysAgo),
    formatRetention(entry.retention),
  ]
  if (entry.weakPoints.length > 0) parts.push(`薄弱：${entry.weakPoints.join('、')}`)
  if (entry.relearn) parts.push('需重新学习')
  else if (entry.due) parts.push('已到期')
  return `${indent}- 《${entry.title}》 · ${parts.join(' · ')}`
}

/** 渲染成给模型看的纯文本；空树与全未学都给出明确的一句话，不留空白。 */
export function renderStudyDigest(digest: StudyDigest): string {
  if (digest.total === 0) return '（这个项目还没有学习记录）'

  const lines = digest.entries.map(renderEntry)
  if (digest.omitted > 0) {
    lines.push(`（还有 ${digest.omitted} 个主题未列出）`)
  }
  return lines.join('\n')
}

/** 距上次学习多少天；UI 与 digest 共用同一口径。 */
export function studiedDaysAgo(node: Node, now: number): number | null {
  return node.lastStudiedAt === undefined ? null : daysAgo(now, node.lastStudiedAt)
}

/** 供 UI 排序：到期时间越早越靠前；没有排期视为 0（立刻）。 */
export function dueSortKey(node: Node): number {
  return dueAt(node) ?? 0
}