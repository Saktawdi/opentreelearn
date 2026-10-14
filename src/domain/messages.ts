import i18n from '@/i18n'
import type { Id, Message, MessagePart } from '@/domain/models'
import { findBranchQuickChoice } from '@/domain/defaults'
import { stripReviewRating } from '@/domain/review/protocol'
import { normalizeForRender } from '@/lib/markdown/render-source'
import { firstLine, truncate } from '@/lib/text'

/** 引用片段以 Markdown 引用行进入模型上下文与导出，让「这段是引用」的语义不丢失。 */
export function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n')
}

/**
 * 完整正文（引用片段 + 自己的话），供模型上下文 / 摘要 / 导出使用。
 * 引用块与后续正文之间留空行，否则 Markdown 会把正文并进引用里。
 *
 * **工具记录一律不进正文**（返回 ''）：摘要、导出、卡片预览、复习材料都读这个函数，
 * 让「我查了一下」混进正文会污染它们。代价是工具查到的信息必须在正文里复述 ——
 * 这条写进了系统提示（见 TOOLS_SYSTEM），是硬要求。
 */
export function messageText(message: Message): string {
  return message.parts
    .map((part) => {
      if (part.type === 'text') return part.text
      if (part.type === 'quote') return quoteBlock(part.text)
      return ''
    })
    .filter((text) => text.trim().length > 0)
    .join('\n\n')
    .trim()
}

/** 用户自己敲的正文（不含引用与图片），编辑与标题用它。 */
export function messageBodyText(message: Message): string {
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

export function messageQuotes(message: Message): string[] {
  return message.parts
    .filter((part): part is { type: 'quote'; text: string } => part.type === 'quote')
    .map((part) => part.text)
}

export function messageImageIds(message: Message): Id[] {
  return message.parts
    .filter((part): part is { type: 'image'; assetId: Id } => part.type === 'image')
    .map((part) => part.assetId)
}

export function hasImage(message: Message): boolean {
  return message.parts.some((part) => part.type === 'image')
}

/** 消息里的工具记录（按顺序）。P-C 之后它们随消息落库，气泡里渲染成工具卡。 */
export type MessageToolPart = Extract<MessagePart, { type: 'tool' }>

export function messageToolParts(message: Message): MessageToolPart[] {
  return message.parts.filter((part): part is MessageToolPart => part.type === 'tool')
}

/** 引用/图片原样保留、只改文字时用：判断编辑后的 parts 有没有实际改动。 */
export function sameMessageParts(a: Message, b: Message): boolean {
  if (a.parts.length !== b.parts.length) return false
  return a.parts.every((part, index) => {
    const other = b.parts[index]
    if (part.type !== other.type) return false
    if (part.type === 'image' && other.type === 'image') return part.assetId === other.assetId
    if (part.type === 'text' && other.type === 'text') return part.text === other.text
    if (part.type === 'quote' && other.type === 'quote') return part.text === other.text
    // 工具记录不该被「编辑消息」改到：比到 callId 与结果就够，参数对象不深比
    if (part.type === 'tool' && other.type === 'tool') {
      return part.callId === other.callId && part.output === other.output && part.error === other.error
    }
    return false
  })
}

/** 编辑用户消息：替换正文（text part），引用与图片原样沿用。 */
export function replaceMessageText(message: Message, text: string): MessagePart[] {
  const parts: MessagePart[] = []
  let replaced = false
  for (const part of message.parts) {
    if (part.type !== 'text') {
      parts.push(part)
      continue
    }
    if (!replaced) {
      parts.push({ type: 'text', text })
      replaced = true
    }
  }
  if (!replaced) parts.push({ type: 'text', text })
  return parts
}

/**
 * 卡片摘录 / fork 预览 / 版本横线都用它。
 *
 * 复习判定标记（`[[rating:good]]`）是给客户端与模型看的协议，不是给用户看的文字，
 * 预览里剥掉；正文渲染同样处理（见 MessageList）。
 */
export function messagePreview(message: Message, max = 120): string {
  const text = stripReviewRating(messageText(message))
  const label = text ? normalizeForPreview(text) : i18n.t('common:fallback.imagePlaceholder')
  return truncate(label, max)
}

function normalizeForPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function deriveTitle(message: Message): string {
  // 标题取用户自己的话；只引用没打字时退用被引用的原文（而不是 "> xxx"）。
  // 快捷指令模板（咨询/解读/…）正文人人一样，当标题会让一批子节点重名 —— 带引用时标题取引用。
  const body = messageBodyText(message)
  const quote = messageQuotes(message)[0]
  if (body && !(quote && findBranchQuickChoice(body))) return firstLine(body, 42)
  if (quote) return firstLine(quote, 42)
  return hasImage(message)
    ? i18n.t('common:fallback.imageQuestionTitle')
    : i18n.t('common:fallback.newNodeTitle')
}

/**
 * **标注坐标系的源文**：正文进入渲染的那串原文，也是笔记 start / end 与 quote 的基准。
 *
 * 为什么不能拿渲染后的文字当坐标：KaTeX 把 `$r^2=2a^2\cos 2\theta$` 排成上下标字形
 * （DOM 文字是 `r2=2a2cos2θ`）、反引号与围栏被吃掉 —— 用户框选到的是字形，
 * 但标注、AI 上下文与写工具要的是模型能读懂的原文（见 lib/markdown/source-map.ts）。
 *
 * 用户与助手气泡都走 MarkdownView，坐标与渲染共用 normalizeForRender。
 * 只有助手消息剥掉复习评分协议；用户输入中的同样文字按原意保留。
 */
export function messageSource(message: Message): string {
  const text = messageText(message)
  return normalizeForRender(message.role === 'user' ? text : stripReviewRating(text))
}
