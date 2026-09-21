import { generateText, type LanguageModel } from 'ai'
import { messageText } from '@/domain/messages'
import type { Message } from '@/domain/models'
import { normalizeWhitespace, truncate } from '@/lib/text'

const TITLE_SYSTEM = [
  '你为学习笔记生成极简标题。',
  '只输出标题本身：不超过 16 个字，不要标点结尾，不要引号，不要解释。',
].join('\n')

const SUMMARY_SYSTEM = [
  '你是学习进展评估助理，负责根据师生对话评估并总结学习者的掌握程度。',
  '要求：',
  '1. 必须且只能输出严格的【一句话总结】（不超过 40 个字）。',
  '2. 核心只总结学习者对当前节点知识的【掌握/理解程度】与状态（如：已基本掌握核心概念、已理清公式推导但在边界条件上仍有疑惑、仅作了初步了解等）。',
  '3. 不要罗列教学过程或原文，不要分点，不要换行，不要任何问候与解释。',
].join('\n')

const WRAPPER_CHARS = '「『【"\'[]」』】'

function stripWrappers(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && WRAPPER_CHARS.includes(text[start])) start += 1
  while (end > start && WRAPPER_CHARS.includes(text[end - 1])) end -= 1
  return text.slice(start, end)
}

function cleanGenerated(raw: string, max: number): string | null {
  const cleaned = stripWrappers(normalizeWhitespace(raw))
    .replace(/[。，、；：!?！？]+$/, '')
    .trim()
  return cleaned ? truncate(cleaned, max) : null
}

export async function generateTitle(
  model: LanguageModel,
  message: Message,
): Promise<string | null> {
  const content = messageText(message)
  if (!content) return null

  const { text } = await generateText({
    model,
    system: TITLE_SYSTEM,
    prompt: content.slice(0, 2000),
  })

  return cleanGenerated(text, 24)
}

export async function generateSummary(
  model: LanguageModel,
  params: { title: string; transcript: string },
): Promise<string | null> {
  const transcript = params.transcript.trim()
  if (!transcript) return null

  const { text } = await generateText({
    model,
    system: SUMMARY_SYSTEM,
    prompt: `节点标题：${params.title}\n\n对话记录：\n${transcript.slice(-6000)}`,
  })

  return cleanGenerated(text, 60)
}

export function buildTranscript(messages: Message[], limit = 40): string {
  return messages
    .slice(-limit)
    .map((message) => {
      const speaker = message.role === 'assistant' ? '导师' : '学习者'
      const text = messageText(message) || '［图片］'
      return `${speaker}：${truncate(text, 600)}`
    })
    .join('\n')
}