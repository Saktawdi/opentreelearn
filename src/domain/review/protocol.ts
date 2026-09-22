import { isReviewGrade, type ReviewGrade } from '@/domain/models'
import type { ReviewRequestPurpose, ReviewSessionMessage } from './session'

/**
 * 复习评分回流的**文本协议**。
 *
 * 复习模式下，导师在点评末尾单独一行输出 `[[rating:good]]`，客户端据此把
 * AI 的判定预选在档位上，用户一键覆盖即可。为什么不做成第二个结构化调用：
 * 判定和点评本来就是同一次回答的两面，再发一次 generateObject 既慢又贵，
 * 还会出现「点评说记得、判定说忘了」的自相矛盾。
 *
 * 标记会留在消息正文里（模型下一轮能看到自己的历史判定），展示时剥掉。
 *
 * **归属比解析更重要**：标记只有出现在「本次回答的完整反馈」里才算数。用户回答、
 * 参考资料、出题、讲解、提示、被中断的文本里出现的标记一律忽略 —— 否则用户只要在
 * 回答里写一句 `[[rating:easy]]` 就能给自己打满分。
 */

const RATING_MARKER = /\[\[\s*rating\s*:\s*(again|hard|good|easy)\s*\]\]/gi

export const REVIEW_RATING_MARKER_HINT =
  '在点评的最后，单独一行输出你的判定：[[rating:again|hard|good|easy]]（四选一，不要输出别的标记）'

/** 解析最后一条判定；没有标记时返回 null（用户仍可手动评分）。 */
export function parseReviewRating(text: string): ReviewGrade | null {
  let found: ReviewGrade | null = null
  for (const match of text.matchAll(RATING_MARKER)) {
    const value = match[1]?.toLowerCase()
    if (isReviewGrade(value)) found = value
  }
  return found
}

/**
 * 允许携带有效评分建议的请求用途。
 *
 * `answer` 是对本次回答的反馈，`followup` 是围绕同一次回答的追问 —— 两者都可能
 * 给出完整点评。出题 / 补学 / 提示 / 换个问法都只是围绕题目的辅助输出，
 * 它们在用户还没回答时就已经产生，不可能包含对回答的判定。
 */
export const RATING_ELIGIBLE_PURPOSES: readonly ReviewRequestPurpose[] = ['answer', 'followup']

export function isRatingEligible(
  purpose: ReviewRequestPurpose | undefined,
  incomplete: boolean | undefined,
): boolean {
  if (!purpose || incomplete) return false
  return RATING_ELIGIBLE_PURPOSES.includes(purpose)
}

/**
 * 从当前项的消息序列里取有效建议。
 *
 * 只认**最后一条**符合用途的完整 assistant 消息：它属于本次回答当前的反馈。
 * 中断的、失败重试前的旧反馈、其他用途的输出都不参与。
 */
export function suggestionFromMessages(
  messages: readonly ReviewSessionMessage[],
): ReviewGrade | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    if (!isRatingEligible(message.purpose, message.incomplete)) continue
    return parseReviewRating(message.text)
  }
  return null
}

const RATING_LINE = /^[ \t]*\[\[\s*rating\s*:\s*(again|hard|good|easy)\s*\]\][ \t]*\r?\n?/gim

/** 展示用：剥掉判定标记；独占一行的标记连整行一起去掉，不留空行。 */
export function stripReviewRating(text: string): string {
  return text.replace(RATING_LINE, '').replace(RATING_MARKER, '').trim()
}

/** 写到一半的标记（`[[`、`[[rat`、`[[rating:`…）；只允许协议本身的字符，不误伤正文。 */
const PARTIAL_MARKER = /\[\[[a-z:\s]*$/i

/**
 * 流式展示用：连写到一半的标记也一起收掉。
 *
 * 不收的话，标记会先原样出现在回答末尾，等消息落库才消失 —— 看起来像卡了一下。
 * 只匹配「`[[` 后面全是协议可能出现的字符」，普通正文里的 `[[` 不会被当成标记。
 */
export function stripStreamingReviewRating(text: string): string {
  return stripReviewRating(text).replace(PARTIAL_MARKER, '').trimEnd()
}