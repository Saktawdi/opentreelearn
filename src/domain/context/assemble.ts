import { DEFAULT_CONTEXT_BUDGET, DEFAULT_RECENT_MESSAGES } from '@/domain/defaults'
import { messageText, quoteBlock } from '@/domain/messages'
import type { Id, Message, Node } from '@/domain/models'
import { resolveThread } from '@/domain/thread/resolve'
import { ancestorsOf, buildTreeIndex, pathTo } from '@/domain/tree/tree'
import { normalizeWhitespace, truncate } from '@/lib/text'
import { estimateTokens } from './tokens'

export type ContextPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string }

export interface ContextMessage {
  role: 'user' | 'assistant'
  parts: ContextPart[]
}

export interface AssembleInput {
  node: Node
  nodes: Node[]
  messagesByNode: Map<Id, Message[]>
  assetUrls?: Map<Id, string>
  backgroundProfile?: string
  projectBackground?: string
  projectSystemPrompt?: string
  budgetTokens?: number
  recentMessages?: number
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
  '回答要准确、结构化、可验证；不确定时明确说明不确定性，不要编造。',
  '当学习者的问题偏离当前节点主题时，先给出简短回答，再提醒可以另开节点深入。',
].join('\n')

const IMAGE_TOKEN_COST = 320
const TRUNCATE_CHARS = 480
const MIN_KEEP_OWN_MESSAGES = 2

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
  return parts.reduce(
    (sum, part) => sum + (part.type === 'text' ? estimateTokens(part.text) : IMAGE_TOKEN_COST),
    0,
  )
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

    const projectPrompt = input.projectSystemPrompt?.trim()
    if (projectPrompt) {
      sections.push(`## 项目要求\n${projectPrompt}`)
    }

    const index = buildTreeIndex(input.nodes)
    const ancestors = ancestorsOf(index, input.node.id)
    const chain = [...ancestors.map((node) => node.title), input.node.title]
    if (chain.length > 0) {
      const rendered = chain.map((title, depth) => `${'  '.repeat(depth)}- ${title}`).join('\n')
      sections.push(`## 当前学习位置\n${rendered}`)
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

  if (cost(state) > budget && ownSegment.messages.length > MIN_KEEP_OWN_MESSAGES) {
    for (let i = 0; i < historySegments.length; i += 1) {
      if (modes[i] === 'note') {
        modes[i] = 'dropped'
      }
    }
    ownSegment.messages = ownSegment.messages.slice(-MIN_KEEP_OWN_MESSAGES)
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