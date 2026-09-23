import { DEFAULT_CONTEXT_BUDGET } from '@/domain/defaults'
import type { Id, Node, Note, ReviewGrade } from '@/domain/models'
import {
  collectUsedLabels,
  countNoteLabels,
  formatNoteLabels,
  labeledNotes,
  renderNoteLegend,
} from '@/domain/notes'
import { buildStudyDigest, renderStudyDigest, treeOrder } from '@/domain/review/digest'
import { gradeOfScore } from '@/domain/review/schedule'
import { normalizeWhitespace, truncate } from '@/lib/text'
import { REVIEW_CENTER_SYSTEM, type ContextMessage, type ContextPart } from './assemble'
import { estimateTokens } from './tokens'

/**
 * 复习工作区的**自由问答**上下文（纯函数，每次发送时重算）。
 *
 * 它存在的理由很具体：复习工作区是点击式的（概览 → 练习 → 反馈 → 小结），
 * 没有「随便问一句」的位置，而「我今天学了什么 / 哪些快忘了」这类问题不需要
 * 走一遍练习流程。旧版复习中心节点能答这类问题（诊断 / 计划 / 答疑），
 * 节点隐藏之后这个能力就断了 —— 这里把规则与信息源原样接回来，但不复活那个节点类型。
 *
 * 与另外两条上下文路径的区别，都是刻意取舍：
 * 1. **不带学习资料与对话原文**（`assembleContext` / `assembleReviewContext` 才带）：
 *    自由问答问的是「我的进度」而不是「这个主题讲了什么」，塞进整条对话只会变贵变慢；
 * 2. **不带评分规则**：这里不产生判定，模型也不该索要回答（见下方 FREE_ASK_BASE）；
 * 3. **不写任何节点数据**：`REVIEW_CENTER_SYSTEM` 已经写死了这条纪律，掌握度与排期
 *    仍然只由用户在节点上显式操作或在练习中确认评分时改变。
 *
 * 信息源有两份，都不冻结：学习快照（到期 / 保持率 / 档位 / 薄弱点）与项目主题清单
 * （标题 / 摘要 / 掌握度 / 创建与最后编辑时间）。前者回答「该复习什么」，后者回答
 * 「我学过什么、什么时候动过它」—— 后者是自由问答相对练习流程的增量。
 */

const SUMMARY_CHARS = 160

/** 默认列出的主题数上限。真到超限时先按「最近编辑过」保留，再还原树序。 */
const DEFAULT_INVENTORY_LIMIT = 80

/** 列出的标注条数上限与每条原文长度：标注是补充信号，不该挤掉主题清单。 */
const NOTE_LIMIT = 12
const NOTE_QUOTE_CHARS = 100

/**
 * 预算不够时的取舍阶梯：先砍每条摘要，再砍清单条数，最后才丢标注。
 *
 * 顺序是刻意的 —— 摘要最长、也最容易被标题代替；而标注是**用户亲口确认的判断**
 * （错题 / 没懂），模型推断不出来，所以排在主题清单之后才牺牲。
 */
const INVENTORY_LADDER: ReadonlyArray<{
  limit: number
  withSummary: boolean
  withNotes: boolean
}> = [
  { limit: DEFAULT_INVENTORY_LIMIT, withSummary: true, withNotes: true },
  { limit: 40, withSummary: false, withNotes: true },
  { limit: 16, withSummary: false, withNotes: true },
  { limit: 6, withSummary: false, withNotes: false },
]

const FREE_ASK_BASE = [
  '你是一位严谨的学科导师，正在和学习者自由讨论。',
  '使用 Markdown 作答；数学公式使用 LaTeX（行内 $...$，行间 $$...$$），只使用标准命令。',
  '回答要准确、结构化、可验证；不确定时明确说明不确定性，不要编造。',
].join('\n')

/**
 * 数据读法说明。
 *
 * 没有这段，模型会把「最后编辑时间」当成学习时间（重命名 / 拖拽 / 生成摘要都会改它）、
 * 把没有排期的主题读成没学过、把保持率当成掌握度。这不是行为约束，是字段释义 ——
 * 口径写错会直接产出错误结论，而错误结论在这个面板里最贵。
 */
const DATA_LEGEND = [
  '## 学习数据的读法',
  '- **学习快照**每行一个主题：掌握档位（again 待巩固 / hard 初步理解 / good 基本掌握 / easy 较熟悉）、上次学习距今天数、当前保持率、薄弱点、是否到期；缩进表示挂载层级。',
  '- **项目主题清单**给出标题、摘要、掌握度分数、创建时间与最后编辑时间；缩进同样表示层级。',
  '- 保持率是「现在还记着的概率」，会随时间下滑，与掌握度不是一回事；它和「已到期」都只对**已加入复习计划**的主题存在，没有排期不等于没学过。',
  '- 「最后编辑时间」包含重命名、拖拽、生成摘要等整理动作，**不等于学习时间**。判断「最近学了什么」要看快照里的上次学习、以及摘要与掌握度的更新时间。',
].join('\n')

export interface StudyInventoryEntry {
  nodeId: Id
  title: string
  /** 树的层级，0 = 根 */
  depth: number
  /** 掌握度分数；未评估为 null（不是 0 分） */
  score: number | null
  /** 掌握档位；未评估为 null */
  band: ReviewGrade | null
  /** 摘要（按预算可能被裁掉） */
  summary: string | null
  createdAt: number
  updatedAt: number
}

export interface StudyInventory {
  entries: StudyInventoryEntry[]
  /** 参与清单的活跃主题总数（含未列出的） */
  total: number
  /** 因超出 limit 未列出的主题数 */
  omitted: number
  /** 已归档主题数：不进清单，但如实说明，别让模型以为它们不存在 */
  archived: number
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * 项目主题清单：标题 + 摘要 + 掌握程度 + 创建 / 最后编辑时间。
 *
 * 旧复习中心与归档节点不参与（与学习快照同一口径：前者不是学习内容，
 * 后者的「最后编辑时间」是整理动作，混进来会把归档读成进度）。
 */
export function buildStudyInventory(
  nodes: Node[],
  options: { limit?: number; withSummary?: boolean } = {},
): StudyInventory {
  const limit = options.limit ?? DEFAULT_INVENTORY_LIMIT
  const withSummary = options.withSummary ?? true
  const archived = nodes.filter((node) => node.status !== 'active').length
  const active = nodes.filter((node) => node.status === 'active' && node.kind !== 'review')
  const ordered = treeOrder(active)

  const all: StudyInventoryEntry[] = ordered.map(({ node, depth }) => ({
    nodeId: node.id,
    title: node.title,
    depth,
    score: node.mastery?.score ?? null,
    band: node.mastery ? gradeOfScore(node.mastery.score) : null,
    summary:
      withSummary && node.summary
        ? truncate(normalizeWhitespace(node.summary), SUMMARY_CHARS)
        : null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  }))

  if (all.length <= limit) return { entries: all, total: all.length, omitted: 0, archived }

  const keep = new Set(
    [...all]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((entry) => entry.nodeId),
  )
  const entries = all.filter((entry) => keep.has(entry.nodeId))
  return { entries, total: all.length, omitted: all.length - entries.length, archived }
}

function renderInventoryEntry(entry: StudyInventoryEntry): string {
  const indent = '  '.repeat(entry.depth)
  const mastery =
    entry.score === null ? '掌握：未评估' : `掌握 ${entry.score}/100（档位 ${entry.band}）`
  const lines = [
    `${indent}- 《${entry.title}》 · ${mastery} · 创建 ${formatDate(entry.createdAt)} · 最后编辑 ${formatDate(entry.updatedAt)}`,
  ]
  if (entry.summary) lines.push(`${indent}    摘要：${entry.summary}`)
  return lines.join('\n')
}

export function renderStudyInventory(inventory: StudyInventory): string {
  if (inventory.total === 0) return '（这个项目还没有学习主题）'

  const lines = inventory.entries.map(renderInventoryEntry)
  if (inventory.omitted > 0) lines.push(`（还有 ${inventory.omitted} 个主题因上下文预算未列出）`)
  if (inventory.archived > 0) lines.push(`（另有 ${inventory.archived} 个已归档主题未列出）`)
  return lines.join('\n')
}

/**
 * 用户标注：只列**带标签**的（纯高亮是用户自己的书签，不外送），每条带节点定位。
 *
 * 没有这段，这个面板答不出「我有哪些还没搞懂的」—— 它会去猜，或者干脆说不知道。
 * 标签释义由 `renderNoteLegend` 统一给出（与复习材料同一份口径）。
 */
function renderNoteSection(nodes: Node[], notes: Note[]): string | null {
  if (notes.length === 0) return null

  const titles = new Map(nodes.map((node) => [node.id, node.title]))
  const lines = notes.map((note) => {
    const title = titles.get(note.nodeId)
    const where = title ? `《${title}》` : ''
    return `- ${formatNoteLabels(note.labels)} ${where}${truncate(normalizeWhitespace(note.quote), NOTE_QUOTE_CHARS)}`
  })

  return `## 用户标注（${countNoteLabels(notes)}）\n${renderNoteLegend(collectUsedLabels(notes))}\n${lines.join('\n')}`
}

export interface FreeAskContextInput {
  nodes: Node[]
  /** 项目里的全部标注；只有带标签的那些会进上下文（见 renderNoteSection） */
  notes?: Note[]
  /** 已经发生的自由问答（含本轮提问），按时间顺序 */
  history: ContextMessage[]
  projectName?: string
  projectDescription?: string
  backgroundProfile?: string
  projectBackground?: string
  projectSystemPrompt?: string
  budgetTokens?: number
  /** 学习快照与清单的时间基准；缺省取当前时间 */
  now?: number
}

export interface FreeAskContext {
  system: string
  messages: ContextMessage[]
  estimatedTokens: number
  /** 实际列出的主题数 / 活跃主题总数，供界面如实说明「参考了多少个主题」 */
  listed: number
  total: number
  /** 实际列出的标注条数（0 = 这个项目还没有带标签的标注） */
  notes: number
}

function partCost(part: ContextPart): number {
  return part.type === 'text' ? estimateTokens(part.text) : 320
}

function messageCost(message: ContextMessage): number {
  return message.parts.reduce((sum, part) => sum + partCost(part), 0)
}

export function assembleFreeAskContext(input: FreeAskContextInput): FreeAskContext {
  const budget = input.budgetTokens ?? DEFAULT_CONTEXT_BUDGET
  const now = input.now ?? Date.now()

  const buildSystem = (
    withSummary: boolean,
    limit: number,
    withNotes: boolean,
  ): { system: string; inventory: StudyInventory; noteCount: number } => {
    const sections: string[] = [FREE_ASK_BASE]

    const background = input.projectBackground?.trim() || input.backgroundProfile?.trim()
    if (background) sections.push(`## 学习者背景\n${background}`)

    const projectInfo: string[] = []
    if (input.projectName?.trim()) projectInfo.push(`- **名称**：${input.projectName.trim()}`)
    if (input.projectDescription?.trim()) {
      projectInfo.push(`- **描述**：${input.projectDescription.trim()}`)
    }
    if (projectInfo.length > 0) sections.push(`## 所属学习项目\n${projectInfo.join('\n')}`)

    const projectPrompt = input.projectSystemPrompt?.trim()
    if (projectPrompt) sections.push(`## 项目要求\n${projectPrompt}`)

    sections.push(REVIEW_CENTER_SYSTEM)
    sections.push(DATA_LEGEND)

    const labeled = withNotes ? labeledNotes(input.notes ?? []).slice(0, NOTE_LIMIT) : []
    const noteSection = renderNoteSection(input.nodes, labeled)
    if (noteSection) sections.push(noteSection)

    const digest = buildStudyDigest(input.nodes, { now })
    sections.push(`## 学习快照\n${renderStudyDigest(digest)}`)

    const inventory = buildStudyInventory(input.nodes, { limit, withSummary })
    sections.push(
      `## 项目主题清单（标题 / 摘要 / 掌握度 / 创建与最后编辑时间）\n${renderStudyInventory(inventory)}`,
    )

    return { system: sections.join('\n\n'), inventory, noteCount: labeled.length }
  }

  // 历史必须留位置：问答历史就是用户看得到的那部分内容，被清单挤掉比清单少几条更糟
  const historyBudget = Math.max(400, Math.floor(budget * 0.35))
  let chosen = buildSystem(
    INVENTORY_LADDER[0].withSummary,
    INVENTORY_LADDER[0].limit,
    INVENTORY_LADDER[0].withNotes,
  )
  for (const step of INVENTORY_LADDER) {
    chosen = buildSystem(step.withSummary, step.limit, step.withNotes)
    if (estimateTokens(chosen.system) + historyBudget <= budget) break
  }

  const systemTokens = estimateTokens(chosen.system)
  const remaining = Math.max(400, budget - systemTokens)

  // 超预算就丢最旧的历史，但**永远保留最后一条**（那是本轮提问，丢了就等于没问）
  let start = 0
  while (start < input.history.length - 1) {
    const cost = input.history.slice(start).reduce((sum, message) => sum + messageCost(message), 0)
    if (cost <= remaining) break
    start += 1
  }
  const messages = input.history.slice(start)

  return {
    system: chosen.system,
    messages,
    estimatedTokens: systemTokens + messages.reduce((sum, message) => sum + messageCost(message), 0),
    listed: chosen.inventory.entries.length,
    total: chosen.inventory.total,
    notes: chosen.noteCount,
  }
}