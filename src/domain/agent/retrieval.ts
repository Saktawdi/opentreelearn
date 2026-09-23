import { messageText } from '@/domain/messages'
import type { Id, Message, Node, Note, Role } from '@/domain/models'
import { formatNoteLabels, labeledNotes, noteLabelName } from '@/domain/notes'
import { resolveThread } from '@/domain/thread/resolve'
import { buildTreeIndex, depthOf } from '@/domain/tree/tree'
import { treeOrder } from '@/domain/review/digest'
import { normalizeWhitespace, truncate } from '@/lib/text'

/**
 * Agent 的**只读检索**：在内存快照上做纯函数查询。
 *
 * 为什么放 domain：检索规则（搜什么、怎么排序、哪些不进结果）是业务口径，
 * 与 AI SDK 无关；工具只是它的一个调用方。放这里才能直接被单测覆盖，
 * 也才可能在将来给别的入口（比如全局搜索框）复用。
 *
 * 快照是一次请求内的数据视图（节点 + 按节点分组的消息 + 全部标注）。
 * 工具执行发生在浏览器里，数据本来就在内存，不需要额外查询层。
 */

export interface ProjectSnapshot {
  nodes: Node[]
  messagesByNode: Map<Id, Message[]>
  /** 项目里的全部标注（含纯高亮）—— 只有带标签的才会被检索到 */
  notes: Note[]
}

/**
 * 参与检索的节点：活跃 + 非复习中心。
 *
 * 与自由问答的主题清单同一口径：复习中心是元数据节点（不是学习内容），
 * 归档节点的「最后编辑时间」是整理动作 —— 混进来会把它们读成学习进度。
 */
function visibleNodes(nodes: Node[]): Node[] {
  return nodes.filter((node) => node.status === 'active' && node.kind !== 'review')
}

function nodeMessages(snapshot: ProjectSnapshot, nodeId: Id): Message[] {
  return resolveThread(
    snapshot.nodes.find((node) => node.id === nodeId) ?? ({ id: nodeId } as Node),
    snapshot.messagesByNode.get(nodeId) ?? [],
  ).path
}

/** 一个节点的全部对话正文（用于「按内容搜」）。 */
function conversationText(snapshot: ProjectSnapshot, nodeId: Id): string {
  return nodeMessages(snapshot, nodeId)
    .map((message) => messageText(message))
    .join('\n')
    .toLowerCase()
}

export interface NodeHit {
  nodeId: Id
  title: string
  summary?: string
  /** 掌握度分数；未评估为 null（不是 0 分） */
  score: number | null
  depth: number
  /** 命中的位置：标题 / 摘要 / 对话内容 —— 让模型说得清这条为什么被查到 */
  matched: 'title' | 'summary' | 'messages'
}

/** 命中位置的排序权重：标题最可信，对话内容最弱（噪声最多）。 */
const MATCH_RANK: Record<NodeHit['matched'], number> = { title: 0, summary: 1, messages: 2 }

/**
 * 按关键词搜节点（标题 / 摘要 / 对话内容）。
 *
 * 中文没有词边界，用子串匹配而不是分词；大小写不敏感只对拉丁字母有意义，
 * 顺带做掉。排序按「命中位置可信度 → 最近学习时间」。
 */
export function searchNodes(
  snapshot: ProjectSnapshot,
  query: string,
  limit = 8,
): NodeHit[] {
  const needle = normalizeWhitespace(query).trim().toLowerCase()
  if (!needle) return []

  const index = buildTreeIndex(snapshot.nodes)
  const hits: NodeHit[] = []

  for (const node of visibleNodes(snapshot.nodes)) {
    const title = node.title ?? ''
    const summary = node.summary ?? ''
    let matched: NodeHit['matched'] | null = null
    if (title.toLowerCase().includes(needle)) matched = 'title'
    else if (summary.toLowerCase().includes(needle)) matched = 'summary'
    else if (conversationText(snapshot, node.id).includes(needle)) matched = 'messages'
    if (!matched) continue

    hits.push({
      nodeId: node.id,
      title,
      ...(summary ? { summary: truncate(normalizeWhitespace(summary), 120) } : {}),
      score: node.mastery?.score ?? null,
      depth: depthOf(index, node.id),
      matched,
    })
  }

  const studiedAt = new Map(
    snapshot.nodes.map((node) => [node.id, node.lastStudiedAt ?? node.updatedAt]),
  )
  hits.sort(
    (a, b) =>
      MATCH_RANK[a.matched] - MATCH_RANK[b.matched] ||
      (studiedAt.get(b.nodeId) ?? 0) - (studiedAt.get(a.nodeId) ?? 0),
  )

  return hits.slice(0, Math.max(1, Math.min(limit, 20)))
}

export interface NodeDetailMessage {
  role: Role
  text: string
}

export interface NodeDetail {
  nodeId: Id
  title: string
  summary?: string
  score: number | null
  weakPoints?: string[]
  lastStudiedAt?: number
  /** 祖先链标题 + 自身：让模型能说「这题的上一级是…」 */
  path: string[]
  /** 显示路径上最近几条对话（每条截断） */
  recentMessages: NodeDetailMessage[]
}

export function getNodeDetail(
  snapshot: ProjectSnapshot,
  nodeId: Id,
  maxMessages = 4,
): NodeDetail | null {
  const node = snapshot.nodes.find((item) => item.id === nodeId)
  if (!node) return null

  const index = buildTreeIndex(snapshot.nodes)
  const ancestry: Node[] = []
  let cursor: Node | undefined = node
  while (cursor) {
    ancestry.unshift(cursor)
    cursor = cursor.parentId ? index.byId.get(cursor.parentId) : undefined
  }

  const path = nodeMessages(snapshot, nodeId)
  const recent = path
    .slice(-Math.max(1, Math.min(maxMessages, 10)))
    .map((message): NodeDetailMessage => {
      const text = normalizeWhitespace(messageText(message))
      return { role: message.role, text: truncate(text || '［图片］', 300) }
    })

  return {
    nodeId: node.id,
    title: node.title,
    ...(node.summary ? { summary: truncate(normalizeWhitespace(node.summary), 200) } : {}),
    score: node.mastery?.score ?? null,
    ...(node.mastery?.weakPoints?.length ? { weakPoints: node.mastery.weakPoints } : {}),
    ...(node.lastStudiedAt !== undefined ? { lastStudiedAt: node.lastStudiedAt } : {}),
    path: ancestry.map((item) => item.title),
    recentMessages: recent,
  }
}

export interface OutlineEntry {
  nodeId: Id
  title: string
  depth: number
  parentId: Id | null
}

/** 树大纲：标题 + 层级。系统提示里只有祖先链，没有旁支，这份大纲补的正是旁支。 */
export function treeOutline(snapshot: ProjectSnapshot): OutlineEntry[] {
  return treeOrder(visibleNodes(snapshot.nodes)).map(({ node, depth }) => ({
    nodeId: node.id,
    title: node.title,
    depth,
    parentId: node.parentId,
  }))
}

export interface LabelStat {
  label: string
  /** 展示名（内置标签给中文名） */
  name: string
  count: number
}

/** 本项目用过的标签与条数：「有 7 条错题、2 条没懂」。 */
export function labelStats(notes: Note[]): LabelStat[] {
  const counts = new Map<string, number>()
  for (const note of labeledNotes(notes)) {
    for (const label of note.labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
  }
  return [...counts.entries()].map(([label, count]) => ({
    label,
    name: noteLabelName(label),
    count,
  }))
}

export interface NoteQuery {
  /** 命中其中**任意一个**标签即算命中（模型问「哪些没搞懂」时会同时列错题与没懂） */
  labels?: string[]
  /** 关键词：在原文与备注里找 */
  query?: string
  /** 限定节点 */
  nodeId?: Id
  limit?: number
}

export interface NoteHit {
  noteId: Id
  nodeId: Id
  /** 节点标题 —— 跨节点定位是这个检索的全部意义：模型要能说出「这题出在《…》里」 */
  nodeTitle: string
  labels: string[]
  /** 标签的展示形态：`[错题][没懂]` */
  labelsText: string
  quote: string
  body?: string
  createdAt: number
}

export interface NoteSearchResult {
  /** 命中总数（可能多于实际返回的条数） */
  total: number
  hits: NoteHit[]
}

/**
 * 搜带标签的标注。
 *
 * **纯高亮永远查不到** —— 那是用户自己的书签，不外送是这套设计的核心约定；
 * 工具是它的另一个出口，不能从这里漏出去。
 */
export function searchLabeledNotes(
  snapshot: ProjectSnapshot,
  options: NoteQuery = {},
): NoteSearchResult {
  const limit = Math.max(1, Math.min(options.limit ?? 8, 20))
  const labels = (options.labels ?? []).map((label) => label.trim()).filter(Boolean)
  const needle = options.query ? normalizeWhitespace(options.query).trim().toLowerCase() : ''
  const titles = new Map(snapshot.nodes.map((node) => [node.id, node.title]))

  const matched = labeledNotes(snapshot.notes).filter((note) => {
    if (options.nodeId && note.nodeId !== options.nodeId) return false
    if (labels.length > 0 && !note.labels.some((label) => labels.includes(label))) return false
    if (needle) {
      const haystack = `${note.quote}\n${note.body ?? ''}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })

  const hits = [...matched]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((note): NoteHit => ({
      noteId: note.id,
      nodeId: note.nodeId,
      nodeTitle: titles.get(note.nodeId) ?? '（节点已删除）',
      labels: note.labels,
      labelsText: formatNoteLabels(note.labels),
      quote: truncate(normalizeWhitespace(note.quote), 200),
      ...(note.body ? { body: truncate(normalizeWhitespace(note.body), 200) } : {}),
      createdAt: note.createdAt,
    }))

  return { total: matched.length, hits }
}