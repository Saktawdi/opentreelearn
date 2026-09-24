import type { Id, ReviewGrade } from '@/domain/models'
import type { ReviewItemPhase, ReviewSessionItem, ReviewSessionMessage } from './session'

/**
 * 交付守卫与「当前题」不变量（纯函数）。
 *
 * Agent 化之后，题目 / 提示 / 反馈由模型通过交付工具写入转录。工具层能校验的
 * 一切状态都来自这里 —— 守卫是代码而不是提示词，模型违反会收到结构化错误并
 * 在同一轮内自纠。
 *
 * 核心不变量：**当前题 = 转录里最后一道未被回答的 question 消息**。回答
 * （purpose 'answer' 的用户消息）出现在它之后才闭合；中间夹的提示、换问法
 * 不影响开放性。守卫、渲染、评分锚定三处共用这一个推导，不允许各自实现。
 */

export type DeliveryCheck = { ok: true } | { ok: false; reason: string }

/** 同一主题内「反馈后重问」的上限：防止 agent 在每次回答后无限再问，主题永远到不了确认。 */
export const REASK_LIMIT_PER_ITEM = 2

/**
 * 当前开放题：从前往后走一遍转录，question 打开、answer 关闭。
 * followup / hint / rephrase 都不改变开放性 —— 换问法产生的是新 question 消息，
 * 它自己会成为当前题。
 */
export function currentOpenQuestion(item: ReviewSessionItem): ReviewSessionMessage | null {
  let open: ReviewSessionMessage | null = null
  for (const message of item.messages) {
    if (message.role === 'assistant' && message.purpose === 'question') open = message
    else if (message.role === 'user' && message.purpose === 'answer') open = null
  }
  return open
}

/** 转录里最后一道 question 消息（不论是否已回答）；没有时为 null。 */
export function latestQuestion(item: ReviewSessionItem): ReviewSessionMessage | null {
  for (let index = item.messages.length - 1; index >= 0; index -= 1) {
    const message = item.messages[index]
    if (message.role === 'assistant' && message.purpose === 'question') return message
  }
  return null
}

/**
 * 出题守卫。
 *
 * - 不带 `rephraseOf`：只允许在**没有**开放题时出题（阶段起点，或反馈轮里旧题
 *   已被回答闭合后的再问）；
 * - 带 `rephraseOf`：必须正好指向当前开放题 —— 换问法取代它，而不是另起一题。
 *
 * 反馈后的再问有三道节流（阶段 3 的反馈轮合并）：必须先有点评（selectedGrade 是
 * 点评写入的）、只有答得吃力才值得再问、每个主题最多重问 `REASK_LIMIT_PER_ITEM` 次。
 */
export function canPoseQuestion(item: ReviewSessionItem, rephraseOf?: Id): DeliveryCheck {
  const open = currentOpenQuestion(item)
  if (rephraseOf !== undefined) {
    if (!open) return { ok: false, reason: '没有可以换问法的开放题目' }
    if (open.id !== rephraseOf) return { ok: false, reason: '只能对当前这道未回答的题换问法' }
    return { ok: true }
  }
  if (open) return { ok: false, reason: '当前已有未回答的题目，先等它被回答' }
  // 补学主题必须先有讲解、学习者确认之后才出题 —— 防止绕过确认闸门
  if (
    item.mode === 'relearn' &&
    !item.messages.some((message) => message.role === 'assistant' && message.purpose === 'relearn')
  ) {
    return { ok: false, reason: '补学主题要先讲关键点，学习者确认后再出题' }
  }

  // 反馈后的再问：点评 →（补讲）→ 再问 的顺序与节流
  const hasAnswer = item.messages.some((message) => message.role === 'user' && message.purpose === 'answer')
  if (hasAnswer) {
    if (!item.selectedGrade) {
      return { ok: false, reason: '先交付点评（submit_feedback）再考虑是否再问' }
    }
    if (!reAskAllowedForGrade(item.selectedGrade)) {
      return { ok: false, reason: '这次答得不错，不需要再问；等学习者确认档位' }
    }
    if (reAskCount(item) >= REASK_LIMIT_PER_ITEM) {
      return {
        ok: false,
        reason: `这个主题已经再问了 ${reAskCount(item)} 次，请让学习者确认档位`,
      }
    }
  }
  return { ok: true }
}

/** 提示守卫：有开放题才有「针对当前题」的提示。 */
export function canGiveHint(item: ReviewSessionItem): DeliveryCheck {
  if (!currentOpenQuestion(item)) return { ok: false, reason: '没有未回答的题目，无从提示' }
  return { ok: true }
}

/**
 * 反馈守卫：最后一条用户消息必须是回答或追问 —— 两条链路都会产生判定。
 * 中间夹的提示不影响（提示是 assistant 消息）。
 */
export function canSubmitFeedback(item: ReviewSessionItem): DeliveryCheck {
  const lastUser = [...item.messages].reverse().find((message) => message.role === 'user')
  if (!lastUser || (lastUser.purpose !== 'answer' && lastUser.purpose !== 'followup')) {
    return { ok: false, reason: '学习者还没有提交回答' }
  }
  return { ok: true }
}

/**
 * 补学 / 补讲守卫。
 *
 * - 起点形态：补学主题、转录为空（补学轮的第一次交付）；
 * - 反馈轮形态（阶段 3，`afterFeedback`）：学习者已提交回答，agent 在点评中
 *   顺带补讲缺口 —— 对复习主题同样成立。顺序由 `canPoseQuestion` /
 *   `canSubmitFeedback` 的守卫链约束（先点评，再补讲，再问）。
 */
export function canTeachKeyPoints(
  item: ReviewSessionItem,
  options: { afterFeedback?: boolean } = {},
): DeliveryCheck {
  if (item.mode === 'relearn' && item.messages.length === 0) return { ok: true }
  if (options.afterFeedback) {
    const lastUser = [...item.messages].reverse().find((message) => message.role === 'user')
    if (lastUser && (lastUser.purpose === 'answer' || lastUser.purpose === 'followup')) {
      return { ok: true }
    }
    return { ok: false, reason: '只有学习者提交回答后才可以在点评中补讲' }
  }
  return { ok: false, reason: '补学内容已经交付过' }
}

/**
 * 反馈后重问次数：出现在某条回答**之后**的 question 消息数。
 * 每次这样的重问都应当先有点评与补讲 —— 超过上限说明 agent 在循环再问。
 */
export function reAskCount(item: ReviewSessionItem): number {
  let count = 0
  let answered = false
  for (const message of item.messages) {
    if (message.role === 'user' && message.purpose === 'answer') answered = true
    else if (message.role === 'assistant' && message.purpose === 'question' && answered) {
      count += 1
      answered = false
    }
  }
  return count
}

/**
 * 从转录推导当前阶段（阶段 3 起 handler 统一用它写 phase）。
 *
 * 合并轮次后一轮可以有多条交付（点评 → 补讲 → 再问），固定的 kind→phase 映射
 * 不再成立 —— 阶段是**整条转录**的函数，每条交付落库后重算一遍：
 *
 * - `relearn`：未出现过回答 = 补学起点（relearning）；回答之后 = 反馈中的补讲
 *   （视为点评的一部分，落回 feedback）；
 * - `question` → answering；用户 `answer` → evaluating；助手 `answer`/`followup`
 *   → feedback；
 * - hint、用户 followup 不改变阶段（提示不改流向；追问在等判定）。
 *
 * 中间态只在流式期间可见，最终态由本轮最后一条交付决定。
 */
export function phaseFromTranscript(messages: ReviewSessionMessage[]): ReviewItemPhase {
  let phase: ReviewItemPhase = 'preparing'
  let seenAnswer = false
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (message.purpose === 'relearn') {
        phase = seenAnswer ? 'feedback' : 'relearning'
      } else if (message.purpose === 'question') {
        phase = 'answering'
      } else if (message.purpose === 'answer' || message.purpose === 'followup') {
        phase = 'feedback'
      }
      // hint：不改变阶段流向
    } else if (message.purpose === 'answer') {
      seenAnswer = true
      phase = 'evaluating'
    }
    // 用户 followup：不改变阶段（正在等判定，或维持既有反馈语义）
  }
  return phase
}

/** 阶段 3 反馈轮自主再问的档位约束：只有答得吃力才值得补讲后再问。 */
export function reAskAllowedForGrade(grade: ReviewGrade): boolean {
  return grade === 'again' || grade === 'hard'
}
