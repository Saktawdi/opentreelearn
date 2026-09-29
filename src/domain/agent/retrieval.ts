import { messageSource } from '@/domain/messages'
import type { Id, Message, Node, Note, NoteOrigin, Role } from '@/domain/models'
import { formatNoteLabels, labeledNotes, noteLabelName, noteOrigin } from '@/domain/notes'
import { resolveThread } from '@/domain/thread/resolve'
import { buildTreeIndex, depthOf, pathTo } from '@/domain/tree/tree'
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

/**
 * 检索作用域：复习会话把**框选的节点集合（含祖先路径）**绑进工具运行时；
 * 缺省（对话 / 自由答）= 全项目，行为与没有这个概念时逐字节一致。
 *
 * 越界是显式动作（`widen`），且 widen 的命中一律带 `scope: 'other'` 来源标注 ——
 * 默认安全：agent 什么都不传，看到的就是作用域内的数据。
 */
export interface RetrievalScope {
  nodeIds: Id[]
}

export type ScopeMark = 'selected' | 'other'

export function inScope(nodeId: Id, scope: RetrievalScope | undefined): boolean {
  return !scope || scope.nodeIds.includes(nodeId)
}

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
    .map((message) => messageSource(message))
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
  /** 仅在绑定作用域时出现：命中来自框选节点（selected）还是显式 widen 的外部（other） */
  scope?: ScopeMark
}

/** 命中位置的排序权重：标题最可信，对话内容最弱（噪声最多）。 */
const MATCH_RANK: Record<NodeHit['matched'], number> = { title: 0, summary: 1, messages: 2 }

/** 作用域排序权重：框选内的命中永远排在 widen 来的外部命中前面。 */
function scopeRank(hit: { scope?: ScopeMark }): number {
  return hit.scope === 'other' ? 1 : 0
}

/**
 * 按关键词搜节点（标题 / 摘要 / 对话内容）。
 *
 * 中文没有词边界，用子串匹配而不是分词；大小写不敏感只对拉丁字母有意义，
 * 顺带做掉。排序按「命中位置可信度 → 最近学习时间」；绑定作用域时框选内优先。
 */
export function searchNodes(
  snapshot: ProjectSnapshot,
  query: string,
  limit = 8,
  options: { scope?: RetrievalScope; widen?: boolean } = {},
): NodeHit[] {
  const needle = normalizeWhitespace(query).trim().toLowerCase()
  if (!needle) return []

  const index = buildTreeIndex(snapshot.nodes)
  const hits: NodeHit[] = []

  for (const node of visibleNodes(snapshot.nodes)) {
    const selected = inScope(node.id, options.scope)
    if (options.scope && !selected && !options.widen) continue

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
      ...(options.scope ? { scope: selected ? 'selected' : 'other' } : {}),
    })
  }

  const studiedAt = new Map(
    snapshot.nodes.map((node) => [node.id, node.lastStudiedAt ?? node.updatedAt]),
  )
  hits.sort(
    (a, b) =>
      scopeRank(a) - scopeRank(b) ||
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
      const text = normalizeWhitespace(messageSource(message))
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
  /** 相对查询根的层级；不给 parentId 时等于整棵树里的层级 */
  depth: number
  parentId: Id | null
  /** 仅在绑定作用域且显式 widen 时出现：这条在框选内（selected）还是框选外（other） */
  scope?: ScopeMark
}

export interface OutlineOptions {
  /** 只看这个节点（含其子孙）的子树；省略 = 各棵树的根 */
  parentId?: Id
  /** 相对层级上限（0 = 只有这一层）；省略 = 不限 */
  depth?: number
  /** 检索作用域（复习绑定）；缺省全项目 */
  scope?: RetrievalScope
  /** 显式跨出作用域：越界节点带 `scope: 'other'` 标注 */
  widen?: boolean
}

export interface TreeOutline {
  /** 查询目标本身（子树模式下用于定位「这是谁的子树」）；目标不可见时为 null */
  root: { nodeId: Id; title: string; path: string[] } | null
  /** 查询范围内的节点总数，含被 `depth` 挡住的深层节点 */
  total: number
  entries: OutlineEntry[]
  /** 有更深的层级没给出 —— 模型据此决定要不要下钻 */
  hasDeeper: boolean
}

/**
 * 树大纲：标题 + 层级。系统提示里只有祖先链，没有旁支，这份大纲补的正是旁支。
 *
 * 两个参数是给**增长**准备的：树会随学习天数长大，而一条工具结果的长度上限是固定的
 * （见 tools/result.ts），所以「整棵树一次性倒出去」不是可选项。`parentId` 把它从
 * dump 变成**钻取**（配合 `search_nodes` 先找目标，再看它的子树），`depth` 给骨干层。
 * 两个都不给 = 尽量给全 —— 调用方（工具层）负责在装不下时降级重试。
 *
 * `total` 与 `entries.length` 的差就是「范围内没给出多少条」：调用方如实报出去，
 * 不让模型把「没看到」读成「不存在」。
 */
export function treeOutline(
  snapshot: ProjectSnapshot,
  options: OutlineOptions = {},
): TreeOutline {
  // 只在**可见且可读**的节点里建索引：归档 / 复习中心照旧不出现，作用域外的节点
  // 不仅不进结果，也不会成为父子关系的桥（框选集是「节点 + 祖先路径」，结构不断）
  const scoped = visibleNodes(snapshot.nodes).filter(
    (node) => options.widen === true || inScope(node.id, options.scope),
  )
  const index = buildTreeIndex(scoped)
  const rootId = options.parentId
  const rootNode = rootId ? (index.byId.get(rootId) ?? null) : null
  const mark = (node: Node): Pick<OutlineEntry, 'scope'> =>
    options.scope && options.widen
      ? { scope: inScope(node.id, options.scope) ? 'selected' : 'other' }
      : {}

  // 遍历口径与学习快照 / 自由问答清单共用同一份 treeOrder：同一份上下文里两处
  // 层级读法必须一致（父 → 子，同级按创建时间），否则模型会看到两种结构。
  // 它也自带孤儿与断链的兜底（父节点被归档时挂到根桶）。
  const ordered = treeOrder(scoped)
  const base =
    rootId && rootNode ? (ordered.find((item) => item.node.id === rootId)?.depth ?? 0) : 0

  const entries: OutlineEntry[] = ordered
    // 子树模式：按祖先链判定，两个节点不在同一条链上就不会混进去。
    // 目标不在可见集里（不存在 / 已归档 / 在作用域外）时为空，由调用方翻成人话。
    .filter(({ node }) => !rootId || pathTo(index, node.id).some((item) => item.id === rootId))
    .map(({ node, depth }) => ({
      nodeId: node.id,
      title: node.title,
      // 子树模式下层数从查询根重新起算，缩进才读得通
      depth: depth - base,
      parentId: node.parentId,
      ...mark(node),
    }))

  const total = entries.length
  const maxDepth = options.depth === undefined ? Number.POSITIVE_INFINITY : Math.max(0, options.depth)
  const shown = entries.filter((entry) => entry.depth <= maxDepth)

  return {
    // 路径取**全量节点**的祖先链（含归档祖先），模型才能说清子树挂在哪一章下面
    root:
      rootId && rootNode
        ? {
            nodeId: rootNode.id,
            title: rootNode.title,
            path: pathTo(buildTreeIndex(snapshot.nodes), rootId).map((node) => node.title),
          }
        : null,
    total,
    entries: shown,
    hasDeeper: shown.length < total,
  }
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
  /** 检索作用域（复习绑定）；缺省全项目 */
  scope?: RetrievalScope
  /** 显式跨出作用域：命中带 `scope: 'other'` 来源标注 */
  widen?: boolean
}

export interface NoteHit {
  noteId: Id
  nodeId: Id
  /** 节点标题 —— 跨节点定位是这个检索的全部意义：模型要能说出「这题出在《…》里」 */
  nodeTitle: string
  labels: string[]
  /** 标签的展示形态：`[错题][没懂]` */
  labelsText: string
  /**
   * 被标原文；**复习期标注不给**（origin: 'review'）——那原文是上一轮的讲解、
   * 很可能就是答案，从工具里漏出去与投喂时回送是同一种污染。
   */
  quote?: string
  /** 复习期标注的备注（用户自己的话），是它替代原文的语义载体 */
  body?: string
  /** 创建面：review 时 quote 缺省，模型应按标签与 body 理解这条命中 */
  origin?: NoteOrigin
  createdAt: number
  /** 仅在绑定作用域时出现：命中来自框选节点（selected）还是显式 widen 的外部（other） */
  scope?: ScopeMark
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
    const selected = inScope(note.nodeId, options.scope)
    if (options.scope && !selected && !options.widen) return false
    if (options.nodeId && note.nodeId !== options.nodeId) return false
    if (labels.length > 0 && !note.labels.some((label) => labels.includes(label))) return false
    if (needle) {
      const haystack = `${note.quote}\n${note.body ?? ''}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })

  const hits = [...matched]
    .sort(
      (a, b) =>
        (options.scope && inScope(a.nodeId, options.scope) ? 0 : 1) -
          (options.scope && inScope(b.nodeId, options.scope) ? 0 : 1) ||
        b.createdAt - a.createdAt,
    )
    .slice(0, limit)
    .map((note): NoteHit => ({
      noteId: note.id,
      nodeId: note.nodeId,
      nodeTitle: titles.get(note.nodeId) ?? '（节点已删除）',
      labels: note.labels,
      labelsText: formatNoteLabels(note.labels),
      // 复习期标注不回送原文（与复习材料的投喂口径一致，见 domain/context/review.ts）
      ...(noteOrigin(note) === 'review'
        ? { origin: 'review' as const }
        : { quote: truncate(normalizeWhitespace(note.quote), 200) }),
      ...(note.body ? { body: truncate(normalizeWhitespace(note.body), 200) } : {}),
      createdAt: note.createdAt,
      ...(options.scope
        ? { scope: inScope(note.nodeId, options.scope) ? 'selected' : 'other' }
        : {}),
    }))

  return { total: matched.length, hits }
}