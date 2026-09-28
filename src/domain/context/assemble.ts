import { DEFAULT_CONTEXT_BUDGET, DEFAULT_RECENT_MESSAGES } from '@/domain/defaults'
import { messageText, quoteBlock } from '@/domain/messages'
import type { Id, Message, Node } from '@/domain/models'
import { buildStudyDigest, renderStudyDigest } from '@/domain/review/digest'
import { REVIEW_RATING_MARKER_HINT } from '@/domain/review/protocol'
import { resolveThread } from '@/domain/thread/resolve'
import { ancestorsOf, buildTreeIndex, pathTo } from '@/domain/tree/tree'
import { normalizeWhitespace, truncate } from '@/lib/text'
import { estimateTokens } from './tokens'

export type ContextPart =
  | { type: 'text'; text: string }
  | { type: 'image'; dataUrl: string }
  /**
   * 一次工具调用与它的结果。
   *
   * 举手记录与结果**同在一个 part 里**，因此任何「整条 part 一起丢」的压缩都不会
   * 撕裂配对；这也是内联方案的核心收益（见设计文档 §7.2）。
   */
  | {
      type: 'tool'
      callId: string
      name: string
      input: unknown
      output?: string
      error?: string
    }

export interface ContextMessage {
  role: 'user' | 'assistant'
  parts: ContextPart[]
}

export interface AssembleInput {
  node: Node
  nodes: Node[]
  messagesByNode: Map<Id, Message[]>
  assetUrls?: Map<Id, string>
  projectName?: string
  projectDescription?: string
  backgroundProfile?: string
  projectBackground?: string
  projectSystemPrompt?: string
  budgetTokens?: number
  recentMessages?: number
  /** 当前节点正处在复习会话中：`review` = 回忆巩固，`relearn` = 低掌握度重新学习 */
  reviewMode?: 'review' | 'relearn'
  /** 学习快照的计算基准时间；缺省取当前时间 */
  now?: number
}

export interface AssembleStats {
  estimatedTokens: number
  compactedNodeIds: Id[]
  droppedNodeIds: Id[]
  truncatedMessages: number
}

export interface AssembleResult {
  system: string
  messages: ContextMessage[]
  stats: AssembleStats
}

const BASE_SYSTEM = [
  '你是一位严谨的学科导师，正在帮助学习者逐步构建知识体系。',
  '使用 Markdown 作答；数学公式使用 LaTeX（行内 $...$，行间 $$...$$），只使用标准命令。',
  '块级公式的 $$ 独占一行：开栏与闭合都不要和其他内容写在同一行；列表里写公式时，公式每一行都与条目正文对齐缩进，不要顶格。',
  '回答要准确、结构化、可验证；不确定时明确说明不确定性，不要编造。',
  '当学习者的问题偏离当前节点主题时，先给出简短回答，再提醒可以另开节点深入。',
].join('\n')

/**
 * 复习中心（kind: 'review'）的系统提示：只做诊断、计划与答疑。
 * 「不改别的节点数据」这句不是客套 —— 它挡住了模型顺手改掌握度的冲动，
 * 评分回流只由学习者按下评分键时发生。
 *
 * 旧中心节点已不再创建，这段规则现在的**唯一出口**是复习工作区里的自由问答
 * （`domain/context/free-ask`）：那里的门面也是「诊断 / 计划 / 答疑」三件事，
 * 两份上下文必须说同一套话，否则模型换个入口就换一套口径。
 */
export const REVIEW_CENTER_SYSTEM = [
  '你现在位于「复习中心」：这里只做三件事 —— 诊断遗忘、制定复习计划、出回忆题与答疑。',
  '不要修改其他节点的任何数据（掌握度、复习排期、摘要都不改）：评分由学习者在原节点复习后按下评分键完成。',
  '出题优先出需要主动回忆的题，尤其是结构性题目（例如「这个主题该挂在哪个主题下面」「A 和 B 是什么关系」），它们比孤立的事实更值得复习。',
  '学习者问「今天复习什么」时，按学习快照给出顺序：先说到期、保持率低、档位生疏的，再给一个能执行完的短清单。',
].join('\n')

/**
 * 复习会话中（原节点里）的导师规则：先让学习者回忆，再点评，最后给判定标记。
 *
 * 「重新学习」与「复习」分开写：低掌握度的节点让学习者硬回忆只会挫败，
 * 先补最小必要的讲解再让他复述，才是对应 FSRS Learning/Relearning 的行为。
 */
const REVIEW_TUTOR_SYSTEM: Record<'review' | 'relearn', string> = {
  review: [
    '这个节点正在复习会话中：以「主动回忆」的方式带学习者复习，而不是重新讲授一遍。',
    '流程：先让学习者凭记忆复述核心内容或回答一个回忆题，再点评对错与缺口；不要一上来就给出完整答案。',
    '出题优先出结构性题目（例如「这个主题该挂在哪个主题下面」「A 和 B 是什么关系」），比孤立的事实更值得复习。',
    `点评结束后给出本次判定：${REVIEW_RATING_MARKER_HINT}`,
  ].join('\n'),
  relearn: [
    '这个节点的掌握度偏低，正在「重新学习」而不是复习：学习者还没到能靠回忆巩固的程度，硬回忆只会挫败。',
    '流程：先用最短的篇幅把最关键的概念/推导讲清（只补缺口，不要从头讲一遍），然后让学习者用自己的话复述一遍。',
    `点评结束后给出本次判定：${REVIEW_RATING_MARKER_HINT}`,
  ].join('\n'),
}

const IMAGE_TOKEN_COST = 320
const TRUNCATE_CHARS = 480

/**
 * 硬压缩时最少保留的本节点**完整轮次**。
 *
 * 单位是「轮次」而不是「条消息」：切点必须落在某条 user 消息之前，绝不能停在
 * 提问与回答之间 —— 工具记录内联在 assistant 消息里，但「切掉提问、留下回答」
 * 本身就会让历史读起来是断的。
 */
const MIN_KEEP_OWN_ROUNDS = 1

/**
 * 从尾部取最后 `rounds` 个完整轮次（每条轮次 = 一条提问 + 它之后的回答）。
 *
 * 提问数不足时原样返回：宁可不压，也不要切出一个半截轮次。
 */
function tailRounds(messages: Message[], rounds: number): Message[] {
  let seen = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'user') continue
    seen += 1
    if (seen === rounds) return messages.slice(index)
  }
  return messages
}

type SegmentMode = 'full' | 'note' | 'dropped'

interface Segment {
  node: Node
  messages: Message[]
}

function cutAt(messages: Message[], messageId: Id): Message[] {
  const index = messages.findIndex((message) => message.id === messageId)
  // fork 点已不在显示路径里（被切走/淘汰）⇒ 退化为整条显示路径，至少不丢上下文
  if (index < 0) return messages
  return messages.slice(0, index + 1)
}

/**
 * 前置脉络 + 本节点：**只认显示路径**。
 *
 * 节点内的历史版本（编辑重发/重新生成）不参与上下文，否则会把没在屏幕上出现的
 * 旧回答也喂给模型；fork 源节点按 fork 时冻结的版本选择解析，之后源节点切版本
 * 不会改写已有子节点的上下文。
 */
export function collectHistorySegments(
  node: Node,
  nodes: Node[],
  messagesByNode: Map<Id, Message[]>,
): Segment[] {
  const segments: Segment[] = []

  if (node.forkFrom) {
    const index = buildTreeIndex(nodes)
    const path = pathTo(index, node.forkFrom.nodeId)
    for (const pathNode of path) {
      const isForkNode = pathNode.id === node.forkFrom.nodeId
      const messages = resolveThread(
        pathNode,
        messagesByNode.get(pathNode.id) ?? [],
        isForkNode ? node.forkFrom.selection : undefined,
      ).path
      segments.push({
        node: pathNode,
        messages: isForkNode ? cutAt(messages, node.forkFrom.messageId) : messages,
      })
    }
  }

  segments.push({
    node,
    messages: resolveThread(node, messagesByNode.get(node.id) ?? []).path,
  })
  return segments
}

interface ConvertOptions {
  maxChars: number
  keepTailFull: number
}

function toContextMessages(
  messages: Message[],
  assetUrls: Map<Id, string> | undefined,
  options: ConvertOptions,
): { messages: ContextMessage[]; truncated: number } {
  const result: ContextMessage[] = []
  let truncated = 0
  const firstUnlimited = Math.max(messages.length - options.keepTailFull, 0)

  messages.forEach((message, index) => {
    if (message.role === 'system') return

    const limited = options.maxChars >= 0 && index < firstUnlimited
    const parts: ContextPart[] = []

    for (const part of message.parts) {
      if (part.type === 'text' || part.type === 'quote') {
        const source = part.type === 'text' ? part.text : quoteBlock(part.text)
        const text = limited ? truncate(source, options.maxChars) : source
        if (limited && text.length < source.length) truncated += 1
        if (text.length > 0) parts.push({ type: 'text', text })
        continue
      }

      if (part.type === 'tool') {
        // 硬压缩时整条丢掉：举手与结果同在一个 part 里，一起消失=配对仍然完整。
        // 丢掉的信息并不算丢答案 —— 系统提示要求工具查到的内容必须在正文里复述过。
        if (options.maxChars >= 0) {
          truncated += 1
          continue
        }
        // 中断留下的半截记录（没有结果也没有错误）不进上下文：它还原不出一次完整调用
        if (part.output === undefined && part.error === undefined) continue
        parts.push({
          type: 'tool',
          callId: part.callId,
          name: part.name,
          input: part.input,
          ...(part.output !== undefined ? { output: part.output } : {}),
          ...(part.error !== undefined ? { error: part.error } : {}),
        })
        continue
      }

      const dataUrl = assetUrls?.get(part.assetId)
      if (message.role === 'user' && dataUrl) {
        parts.push({ type: 'image', dataUrl })
      } else {
        parts.push({ type: 'text', text: '［图片］' })
      }
    }

    if (parts.length === 0) {
      parts.push({ type: 'text', text: '［空消息］' })
    }

    result.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      parts,
    })
  })

  return { messages: result, truncated }
}

function renderNote(segment: Segment): string {
  const lines = [`- 《${segment.node.title}》`]
  const firstUser = segment.messages.find((message) => message.role === 'user')
  if (firstUser) {
    lines.push(`  起点：${truncate(normalizeWhitespace(messageText(firstUser)), 160)}`)
  }

  const summary = segment.node.summary?.trim()
  if (summary) {
    lines.push(`  进展：${truncate(normalizeWhitespace(summary), 300)}`)
  } else {
    const lastAssistant = [...segment.messages]
      .reverse()
      .find((message) => message.role === 'assistant')
    if (lastAssistant) {
      lines.push(`  近期回答：${truncate(normalizeWhitespace(messageText(lastAssistant)), 220)}`)
    }
  }

  return lines.join('\n')
}

function partsCost(parts: ContextPart[]): number {
  return parts.reduce((sum, part) => {
    if (part.type === 'text') return sum + estimateTokens(part.text)
    if (part.type === 'image') return sum + IMAGE_TOKEN_COST
    return sum + estimateTokens(part.output ?? part.error ?? '')
  }, 0)
}

export function assembleContext(input: AssembleInput): AssembleResult {
  const budget = input.budgetTokens ?? DEFAULT_CONTEXT_BUDGET
  const recent = input.recentMessages ?? DEFAULT_RECENT_MESSAGES

  const segments = collectHistorySegments(input.node, input.nodes, input.messagesByNode)
  const ownSegment = segments[segments.length - 1]
  const historySegments = segments.slice(0, -1)

  const modes: SegmentMode[] = historySegments.map(() => 'full')
  const notes = new Map<Id, string>()
  let hardMode = false

  const buildSystem = (): string => {
    const sections = [BASE_SYSTEM]

    const background = input.projectBackground?.trim() || input.backgroundProfile?.trim()
    if (background) {
      sections.push(`## 学习者背景\n${background}`)
    }

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
    if (projectPrompt) {
      sections.push(`## 项目要求\n${projectPrompt}`)
    }

    if (input.node.kind === 'review') {
      // 复习中心不参与学习树定位，走学习快照（每次发送时重算，不冻结）
      sections.push(REVIEW_CENTER_SYSTEM)
      const digest = buildStudyDigest(input.nodes, { now: input.now ?? Date.now() })
      sections.push(`## 学习快照\n${renderStudyDigest(digest)}`)
    } else {
      const index = buildTreeIndex(input.nodes)
      const ancestors = ancestorsOf(index, input.node.id)
      const chain = [...ancestors.map((node) => node.title), input.node.title]
      if (chain.length > 0) {
        const rendered = chain.map((title, depth) => `${'  '.repeat(depth)}- ${title}`).join('\n')
        sections.push(`## 当前学习位置\n${rendered}`)
      }
    }

    const seed = (input.node.contextSeed ?? [])
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    if (seed.length > 0) {
      sections.push(`## 本节点建立时的上下文\n${seed.join('\n\n')}`)
    }

    const compactedNotes = historySegments
      .map((segment, i) => (modes[i] === 'note' ? notes.get(segment.node.id) : undefined))
      .filter((note): note is string => Boolean(note))
    if (compactedNotes.length > 0) {
      sections.push(`## 前置脉络（已压缩）\n${compactedNotes.join('\n')}`)
    }

    const droppedCount = modes.filter((mode) => mode === 'dropped').length
    if (droppedCount > 0) {
      sections.push(`（更早的 ${droppedCount} 个前置节点因上下文预算已省略）`)
    }

    if (input.reviewMode && input.node.kind !== 'review') {
      sections.push(REVIEW_TUTOR_SYSTEM[input.reviewMode])
    }

    return sections.join('\n\n')
  }

  interface Materialized {
  system: string
  messages: ContextMessage[]
  truncated: number
}

const materialize = (): Materialized => {
    const messages: ContextMessage[] = []
    const maxChars = hardMode ? TRUNCATE_CHARS : -1
    let truncated = 0

    historySegments.forEach((segment, i) => {
      if (modes[i] !== 'full') return
      const converted = toContextMessages(segment.messages, input.assetUrls, {
        maxChars,
        keepTailFull: 0,
      })
      messages.push(...converted.messages)
      truncated += converted.truncated
    })

    const own = toContextMessages(ownSegment.messages, input.assetUrls, {
      maxChars,
      keepTailFull: hardMode ? 0 : recent,
    })
    messages.push(...own.messages)
    truncated += own.truncated

    return { system: buildSystem(), messages, truncated }
  }

  const cost = (state: Materialized): number =>
    estimateTokens(state.system) +
    state.messages.reduce((sum, message) => sum + partsCost(message.parts), 0)

  let state = materialize()

  for (let i = 0; i < historySegments.length && cost(state) > budget; i += 1) {
    modes[i] = 'note'
    notes.set(historySegments[i].node.id, renderNote(historySegments[i]))
    state = materialize()
  }

  for (let i = 0; i < historySegments.length && cost(state) > budget; i += 1) {
    if (modes[i] !== 'note') continue
    modes[i] = 'dropped'
    state = materialize()
  }

  if (cost(state) > budget) {
    hardMode = true
    state = materialize()
  }

  if (cost(state) > budget && ownSegment.messages.length > MIN_KEEP_OWN_ROUNDS * 2) {
    for (let i = 0; i < historySegments.length; i += 1) {
      if (modes[i] === 'note') {
        modes[i] = 'dropped'
      }
    }
    ownSegment.messages = tailRounds(ownSegment.messages, MIN_KEEP_OWN_ROUNDS)
    state = materialize()
  }

  return {
    system: state.system,
    messages: state.messages,
    stats: {
      estimatedTokens: cost(state),
      compactedNodeIds: historySegments
        .filter((_, i) => modes[i] === 'note')
        .map((segment) => segment.node.id),
      droppedNodeIds: historySegments
        .filter((_, i) => modes[i] === 'dropped')
        .map((segment) => segment.node.id),
      truncatedMessages: state.truncated,
    },
  }
}