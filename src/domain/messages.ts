import type { Id, Message } from '@/domain/models'
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

/** 用户自己敲的正文（不含引用与图片），气泡与标题用它。 */
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

export function messagePreview(message: Message, max = 120): string {
  const text = messageText(message)
  const label = text ? normalizeForPreview(text) : '［图片］'
  return truncate(label, max)
}

function normalizeForPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function deriveTitle(message: Message): string {
  // 标题取用户自己的话；只引用没打字时退用被引用的原文（而不是 "> xxx"）
  const body = messageBodyText(message)
  if (body) return firstLine(body, 42)
  const quote = messageQuotes(message)[0]
  if (quote) return firstLine(quote, 42)
  return hasImage(message) ? '［图片提问］' : '新节点'
}
