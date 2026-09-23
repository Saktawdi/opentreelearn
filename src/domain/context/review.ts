import { DEFAULT_CONTEXT_BUDGET } from '@/domain/defaults'
import { messageText } from '@/domain/messages'
import type { Id, Message, Node, Note, ReviewGrade } from '@/domain/models'
import {
  collectUsedLabels,
  countNoteLabels,
  formatNoteLabels,
  labeledNotes,
  renderNoteLegend,
} from '@/domain/notes'
import { REVIEW_RATING_MARKER_HINT } from '@/domain/review/protocol'
import type { ReviewRequestPurpose } from '@/domain/review/session'
import { resolveThread, threadPathFingerprint } from '@/domain/thread/resolve'
import { ancestorsOf, buildTreeIndex } from '@/domain/tree/tree'
import { normalizeWhitespace, truncate } from '@/lib/text'
import { estimateTokens } from './tokens'

/**
 * 复习专用上下文组装（纯函数）。
 *
 * 与学习对话的 `assembleContext` 分开，原因是两者的**目标不同**：学习对话要让模型
 * 接着往下讲，复习要让模型**先问、再判**。混用会带来两个后果 —— 复习时把原答案
 * 直接喂到对话流里（等于把答案念给用户听），以及普通对话被套上「先让用户回忆」
 * 的规则（用户只是来问问题的）。
 *
 * 三条硬约束：
 * 1. **只认显示路径**：T-127 的历史版本不进材料，fork 来源按冻结的选择解析；
 * 2. **材料与对话分开**：学习资料进 system（会被裁剪，裁剪后**如实记进快照**），
 *    用户回答进 messages（是内容，不是指令）；
 * 3. **用途决定规则**：出题不许给答案，反馈才允许给判定标记。
 */

export type ReviewContextPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string }

export interface ReviewContextMessage {
  role: 'user' | 'assistant'
  parts: ReviewContextPart[]
}

export interface ReviewMaterial {
  /** 经预算裁剪后**实际使用**的材料文本 */
  text: string
  /** 材料来源版本指纹（可见路径） */
  versionId: string
  /** 原始材料是否被裁掉了一部分 */
  truncated: boolean
}

export interface ReviewMaterialInput {
  node: Node
  nodes: Node[]
  messagesByNode: Map<Id, Message[]>
  /**
   * 按**消息**分组的标注（键是 messageId，与 `workspace-store.notesByMessage` 同口径）。
   *
   * 旧实现拿 nodeId 去查这张表，永远查不到 —— 那段「本主题的笔记」从未生效过
   * （演进方案 4.1 的死代码）。这里改成先取本节点的消息、再按消息取标注。
   */
  notesByMessage?: Map<Id, Note[]>
  budgetTokens?: number
}

const MATERIAL_HEADER = '## 学习资料（只作为出题与点评的依据，不要直接整段念给学习者）'

/**
 * 标注的渲染：`- [错题][没懂] 判断动量是否守恒时忽略了竖直方向`。
 *
 * 只给标签与原文，**不给备注**：备注默认不进 AI 上下文（演进方案 4.4）——
 * 标签必须能独立表达完整意思，细节留到工具显式索取全文时再给。
 */
function renderLabeledNotes(notes: Note[]): string[] {
  return notes.map((note) => {
    const quote = truncate(normalizeWhitespace(note.quote), 120)
    return `- ${formatNoteLabels(note.labels)} ${quote}`
  })
}

/**
 * 本节点**显示路径上**带标签的标注。
 *
 * 两道过滤都是刻意的：
 * 1. 只认显示路径 —— 挂在被切走/淘汰的历史版本上的标注，对应的正文根本不在屏幕上；
 * 2. 只认带标签的 —— 纯高亮是用户自己的书签，原文模型本来就看得到，送进去只是噪声。
 */
function collectLabeledNotes(
  nodeId: Id,
  path: Message[],
  messagesByNode: Map<Id, Message[]>,
  notesByMessage: Map<Id, Note[]> | undefined,
): Note[] {
  if (!notesByMessage) return []
  const pathIds = new Set(path.map((message) => message.id))
  const own = (messagesByNode.get(nodeId) ?? []).flatMap(
    (message) => notesByMessage.get(message.id) ?? [],
  )
  return labeledNotes(own.filter((note) => pathIds.has(note.messageId)))
}

/**
 * 组装本次复习实际使用的学习材料。
 *
 * 裁剪顺序刻意是「先砍对话长度，再砍整段对话」：摘要与薄弱点是评估结论，
 * 信息密度最高，最后才轮到它们被牺牲。
 */
export function buildReviewMaterial(input: ReviewMaterialInput): ReviewMaterial {
  const { node, nodes, messagesByNode } = input
  const budget = input.budgetTokens ?? DEFAULT_CONTEXT_BUDGET
  const index = buildTreeIndex(nodes)
  const ancestors = ancestorsOf(index, node.id)
  const path = resolveThread(node, messagesByNode.get(node.id) ?? []).path
  const versionId = threadPathFingerprint(path)

  const chain = [...ancestors.map((item) => item.title), node.title]
  const pathLine = chain.map((title, depth) => `${'  '.repeat(depth)}- ${title}`).join('\n')

  const notes = collectLabeledNotes(node.id, path, messagesByNode, input.notesByMessage)

  const transcriptLines = path.map((message, position) => {
    const speaker = message.role === 'assistant' ? '导师' : '学习者'
    return `${position + 1}. ${speaker}：${truncate(normalizeWhitespace(messageText(message)) || '［图片］', 600)}`
  })

  // 材料预算只占上下文预算的一部分：对话还要留位置，否则一长段材料会把回答挤掉
  const materialBudget = Math.max(600, Math.floor(budget * 0.6))
  const sections = (): string[] => [
    `## 当前主题\n${pathLine}`,
    node.summary ? `## 学习摘要\n${truncate(normalizeWhitespace(node.summary), 200)}` : '',
    node.mastery?.weakPoints?.length
      ? `## 上次评估发现的薄弱点\n${node.mastery.weakPoints.map((point) => `- ${point}`).join('\n')}`
      : '',
    notes.length > 0
      ? `## 用户标注（${countNoteLabels(notes)}）\n${renderNoteLegend(collectUsedLabels(notes))}\n${renderLabeledNotes(notes.slice(0, 20)).join('\n')}`
      : '',
    transcriptLines.length > 0
      ? `## 原学习对话（按时间顺序）\n${transcriptLines.join('\n')}`
      : '## 原学习对话\n（这个主题还没有对话记录）',
  ]

  let body = sections().filter((section) => section.length > 0).join('\n\n')
  let truncated = false

  // 第一轮：裁掉过长的对话正文
  if (estimateTokens(body) > materialBudget) {
    truncated = true
    const half = transcriptLines.map((line) => truncate(line, 200))
    body = sections()
      .map((section, position) => (position === 4 ? `## 原学习对话（已压缩）\n${half.join('\n')}` : section))
      .filter((section) => section.length > 0)
      .join('\n\n')
  }

  // 第二轮：只留最近的若干轮，仍超预算就再砍一半
  for (let keep = 12; keep >= 2 && estimateTokens(body) > materialBudget; keep = Math.floor(keep / 2)) {
    truncated = true
    const recent = transcriptLines.slice(-keep)
    body = sections()
      .map((section, position) =>
        position === 4
          ? `## 原学习对话（已压缩为最近 ${recent.length} 轮）\n${recent.join('\n')}`
          : section,
      )
      .filter((section) => section.length > 0)
      .join('\n\n')
  }

  // 最后一轮：连对话都不留，只保留主题、摘要与薄弱点
  if (estimateTokens(body) > materialBudget) {
    truncated = true
    body = sections()
      .filter((_, position) => position <= 2)
      .filter((section) => section.length > 0)
      .join('\n\n')
  }

  return {
    text: `${MATERIAL_HEADER}\n${truncate(body, Math.max(1200, materialBudget * 2))}`,
    versionId,
    truncated,
  }
}

const BASE_TUTOR = [
  '你是一位严谨的学科导师，正在陪学习者做一次**复习**。',
  '使用 Markdown 作答；数学公式使用 LaTeX（行内 $...$，行间 $$...$$），只使用标准命令。',
  '回答准确、简洁，不要客套，不要复述学习者的整段回答。',
].join('\n')

/**
 * 各用途的规则。
 *
 * 出题与补学**明确禁止**输出判定标记：它们发生在学习者回答之前，
 * 那时候任何「判定」都只是模型在猜。
 */
const PURPOSE_RULES: Record<ReviewRequestPurpose, string> = {
  question: [
    '本轮任务：出**一道**需要主动回忆的题。',
    '优先出结构性题目（例如「这个主题该挂在哪个主题下面」「A 和 B 是什么关系」「为什么会有这一步」），比孤立的事实更值得回忆。',
    '只出题，**不要给出答案、不要提示思路**；用「用自己的话解释：…」这样的问句结束。',
    '不要输出任何评分标记。',
  ].join('\n'),
  hint: [
    '本轮任务：学习者卡住了，给**一点**提示。',
    '提示只给方向（该回忆哪一部分、从哪个条件入手），不要写出完整答案，不要代答。',
    '不要输出任何评分标记。',
  ].join('\n'),
  rephrase: [
    '本轮任务：把当前这道题**换个问法**重新表达一遍。',
    '考查的知识点必须完全相同，不要偷偷加新题、也不要换成别的知识点。',
    '只输出新问法本身，不要解释你换了什么说法。不要输出任何评分标记。',
  ].join('\n'),
  relearn: [
    '这个主题的掌握度偏低，本轮是**补学**而不是复习：学习者还没到能靠回忆巩固的程度，硬回忆只会挫败。',
    '本轮任务：用最短的篇幅把最关键的概念 / 推导讲清楚（只补缺口，不要从头讲一遍）。',
    '讲完请让学习者用自己的话复述一遍。不要输出任何评分标记。',
  ].join('\n'),
  answer: [
    '本轮任务：对学习者的回答给出反馈。',
    '结构：先指出**做对的地方**，再指出**待补充 / 需要修正的地方**（如果答错了就直接说清楚正确思路）。',
    '最后给一个本次判定：',
    REVIEW_RATING_MARKER_HINT,
  ].join('\n'),
  followup: [
    '本轮任务：回答学习者围绕这道题的追问。',
    '如果这一轮已经把对错讲清楚了，最后同样给出本次判定：',
    REVIEW_RATING_MARKER_HINT,
  ].join('\n'),
}

export interface ReviewContextInput {
  node: Node
  purpose: ReviewRequestPurpose
  material: ReviewMaterial
  /** 本项已经产生的消息（题目、提示、学习者回答…），按时间顺序 */
  history: ReviewContextMessage[]
  projectName?: string
  projectDescription?: string
  backgroundProfile?: string
  projectBackground?: string
  projectSystemPrompt?: string
  /** 本次参考过提示 / 资料：明确告知模型，避免它把「有提示」当成「独立回忆」 */
  usedHint?: boolean
  usedSource?: boolean
  /** 本次会话里的主题进度说明，例如「这是本次第 2 / 3 个主题」 */
  progressNote?: string
}

export interface ReviewContext {
  system: string
  messages: ReviewContextMessage[]
  estimatedTokens: number
}

export function assembleReviewContext(input: ReviewContextInput): ReviewContext {
  const sections = [BASE_TUTOR]

  const background = input.projectBackground?.trim() || input.backgroundProfile?.trim()
  if (background) sections.push(`## 学习者背景\n${background}`)

  const projectInfo: string[] = []
  if (input.projectName?.trim()) {
    projectInfo.push(`- **名称**：${input.projectName.trim()}`)
  }
  if (input.projectDescription?.trim()) {
    projectInfo.push(`- **描述**：${input.projectDescription.trim()}`)
  }
  if (projectInfo.length > 0) {
    sections.push(`## 所属学习项目\n${projectInfo.join('\n')}`)
  }

  const projectPrompt = input.projectSystemPrompt?.trim()
  if (projectPrompt) sections.push(`## 项目要求\n${projectPrompt}`)

  sections.push(input.material.text)
  sections.push(`## 本轮规则\n${PURPOSE_RULES[input.purpose]}`)

  if (input.progressNote) sections.push(`## 本次进度\n${input.progressNote}`)
  if (input.usedHint || input.usedSource) {
    const parts: string[] = []
    if (input.usedHint) parts.push('看过提示')
    if (input.usedSource) parts.push('查看过资料')
    sections.push(
      `## 本次参考\n学习者${parts.join('、')}。点评时如实说明，但不要因此强行降档。`,
    )
  }

  const system = sections.join('\n\n')
  const messages = input.history
  const estimatedTokens =
    estimateTokens(system) +
    messages.reduce(
      (sum, message) =>
        sum +
        message.parts.reduce((partSum, part) => {
          if (part.type === 'text') return partSum + estimateTokens(part.text)
          return partSum + 320
        }, 0),
      0,
    )

  return { system, messages, estimatedTokens }
}

/** 复习消息里的展示文本：剥掉判定标记（正文、流式预览、记录预览都不展示原始标记）。 */
export function reviewHistoryFrom(
  entries: Array<{ role: 'user' | 'assistant'; text: string; purpose: ReviewRequestPurpose }>,
): ReviewContextMessage[] {
  return entries.map((entry) => ({
    role: entry.role,
    parts: [{ type: 'text', text: entry.text }],
  }))
}

/** 档位 → 给模型看的历史判定说明（模型下一轮才知道自己刚才判了什么）。 */
export function renderGradeNote(grade: ReviewGrade): string {
  return `（本次判定：${grade}）`
}

/** 主题路径的一句话描述，供顶部栏与小结使用。 */
export function topicPathLabel(node: Node, nodes: Node[]): string {
  const index = buildTreeIndex(nodes)
  const chain = [...ancestorsOf(index, node.id).map((item) => item.title), node.title]
  return chain.join(' / ')
}