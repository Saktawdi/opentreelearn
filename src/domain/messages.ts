import type { Id, Message } from '@/domain/models'
import { firstLine, truncate } from '@/lib/text'

export function messageText(message: Message): string {
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
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
  const text = messageText(message)
  if (text) return firstLine(text, 42)
  return hasImage(message) ? '［图片提问］' : '新节点'
}