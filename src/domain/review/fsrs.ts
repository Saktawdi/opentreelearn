import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from 'ts-fsrs'
import type { ReviewCard, ReviewCardState, ReviewGrade } from '@/domain/models'

/**
 * ts-fsrs 适配层。
 *
 * 边界只有两个方向：
 * - 进入：把我们的 `ReviewCard`（纯 number、时间戳是 epoch ms）转成 ts-fsrs 的 `Card`（Date）；
 * - 出来：把 ts-fsrs 返回的 `Card` 转回我们的形状。
 *
 * 为什么要这层壳：
 * - ts-fsrs 6.0 会移除 `elapsed_days` 与挂在 `Date.prototype` 上的 `scheduler / diff /
 *   format` 方法，我们的存储形状不跟着动，升级只改这里；
 * - `elapsed_days` 是废弃字段，我们**不读也不写**，只在构造 `Card` 时给类型占位
 *   （ts-fsrs 内部会按 `last_review` 自己重算）。
 */

/** 全局唯一的调度器实例：默认参数即 FSRS-6，关闭 fuzz（排期必须可复现）。 */
const scheduler = fsrs()

const STATE_TO_FSRS: Record<ReviewCardState, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
}

const FSRS_TO_STATE: Record<State, ReviewCardState> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
}

const GRADE_TO_RATING: Record<ReviewGrade, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
}

/**
 * 我们的形状 → ts-fsrs 的 `Card`。
 *
 * 从 `createEmptyCard` 起手再赋值，而不是写对象字面量：`Card` 接口里带着
 * `elapsed_days` 这个 6.0 要删的字段，字面量写法会把废弃 API 焊进我们的代码。
 */
function toFsrsCard(card: ReviewCard): Card {
  const target = createEmptyCard(new Date(card.due))
  target.stability = card.stability
  target.difficulty = card.difficulty
  target.scheduled_days = card.scheduledDays
  target.learning_steps = card.learningSteps
  target.reps = card.reps
  target.lapses = card.lapses
  target.state = STATE_TO_FSRS[card.state]
  if (card.lastReview !== undefined) target.last_review = new Date(card.lastReview)
  return target
}

/** ts-fsrs 的 `Card` → 我们的形状（只保留不废弃的字段）。 */
function fromFsrsCard(card: Card): ReviewCard {
  return {
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: FSRS_TO_STATE[card.state],
    ...(card.last_review ? { lastReview: card.last_review.getTime() } : {}),
  }
}

/** 一张全新的卡（State.New），`due` = `now`。 */
export function createReviewCard(now: number): ReviewCard {
  return fromFsrsCard(createEmptyCard(new Date(now)))
}

/** 按评分推进一张卡；`again` 在 Review 状态下会让 lapses +1（由 FSRS 决定）。 */
export function scheduleReview(
  card: ReviewCard,
  grade: ReviewGrade,
  now: number,
): ReviewCard {
  const { card: next } = scheduler.next(toFsrsCard(card), new Date(now), GRADE_TO_RATING[grade])
  return fromFsrsCard(next)
}

/**
 * 当前保持率（0-1）。新卡没有可回忆的记忆，返回 0；坏数据（非 New 却没有
 * 上次复习时间）也返回 0，绝不把异常抛到渲染期。
 */
export function reviewRetrievability(card: ReviewCard, now: number): number {
  if (card.state === 'new') return 0
  const fsrsCard = toFsrsCard(card)
  if (!fsrsCard.last_review) return 0
  const value = scheduler.get_retrievability(fsrsCard, new Date(now), false)
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
}