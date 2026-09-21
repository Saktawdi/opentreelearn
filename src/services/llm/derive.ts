import { generateText, Output, type LanguageModel } from 'ai'
import { z } from 'zod'
import { messageText } from '@/domain/messages'
import type { Message } from '@/domain/models'
import { clampScore } from '@/domain/review/schedule'
import { normalizeWhitespace, truncate } from '@/lib/text'

const TITLE_SYSTEM = [
  '你为学习笔记生成极简标题。',
  '只输出标题本身：不超过 16 个字，不要标点结尾，不要引号，不要解释。',
].join('\n')

const SUMMARY_SYSTEM = [
  '你是学习进展评估助理，负责根据师生对话评估并总结学习者的掌握程度。',
  '要求：',
  '1. summary：一句话总结（不超过 40 个字），只总结学习者对当前节点知识的【掌握/理解程度】与状态（如：已基本掌握核心概念、已理清公式推导但在边界条件上仍有疑惑、仅作了初步了解等）。不要罗列教学过程或原文，不要分点，不要换行，不要任何问候与解释。',
  '2. mastery：学习者对当前节点知识的掌握程度，0-100 的整数。0 = 完全没有概念，100 = 能完整复述并灵活推导。只根据对话里的证据判断，不要客套性给高分。',
  '3. weakPoints：最多 3 条具体薄弱点（每条不超过 20 字），没有明显薄弱点时给空数组。',
].join('\n')

/** 不支持结构化输出的 provider 退回纯文本摘要时用。 */
const SUMMARY_TEXT_SYSTEM = [
  '你是学习进展评估助理，负责根据师生对话评估并总结学习者的掌握程度。',
  '要求：',
  '1. 必须且只能输出严格的【一句话总结】（不超过 40 个字）。',
  '2. 核心只总结学习者对当前节点知识的【掌握/理解程度】与状态（如：已基本掌握核心概念、已理清公式推导但在边界条件上仍有疑惑、仅作了初步了解等）。',
  '3. 不要罗列教学过程或原文，不要分点，不要换行，不要任何问候与解释。',
].join('\n')

const summarySchema = z.object({
  summary: z.string().describe('一句话学习摘要，不超过 40 个字'),
  mastery: z.number().describe('对当前节点知识的掌握程度，0-100 的整数'),
  weakPoints: z.array(z.string()).describe('最多 3 条具体薄弱点；没有就给空数组'),
})

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

function cleanWeakPoints(values: string[]): string[] {
  const result: string[] = []
  for (const value of values) {
    const cleaned = normalizeWhitespace(value).trim()
    if (!cleaned) continue
    result.push(truncate(cleaned, 24))
    if (result.length === 3) break
  }
  return result
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

export interface SummaryAssessment {
  summary: string
  /** 掌握度（0-100）；provider 不支持结构化输出时为 null，此时只更新摘要 */
  mastery: number | null
  /** AI 给出的薄弱点（至多 3 条）；只做出题材料，不参与调度 */
  weakPoints: string[]
}

/**
 * 一次结构化调用同时拿到 summary / mastery / weakPoints。
 *
 * 用 AI SDK 7 的 `generateText + Output.object`（`generateObject` 已被官方标为
 * deprecated，两者是同一套结构化输出机制）。结构化输出不是所有 provider 都支持
 * （自建中转尤其常见），失败时退回纯文本摘要：宁可这次没有掌握度，
 * 也不要写一个瞎编的分数进排期。
 */
export async function generateSummary(
  model: LanguageModel,
  params: { title: string; transcript: string },
): Promise<SummaryAssessment | null> {
  const transcript = params.transcript.trim()
  if (!transcript) return null

  const prompt = `节点标题：${params.title}\n\n对话记录：\n${transcript.slice(-6000)}`

  try {
    const { output } = await generateText({
      model,
      system: SUMMARY_SYSTEM,
      prompt,
      output: Output.object({ schema: summarySchema, name: 'learning_assessment' }),
    })

    const summary = cleanGenerated(output.summary, 60)
    if (!summary) return null

    return {
      summary,
      mastery: clampScore(output.mastery),
      weakPoints: cleanWeakPoints(output.weakPoints),
    }
  } catch {
    const { text } = await generateText({ model, system: SUMMARY_TEXT_SYSTEM, prompt })
    const summary = cleanGenerated(text, 60)
    return summary ? { summary, mastery: null, weakPoints: [] } : null
  }
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