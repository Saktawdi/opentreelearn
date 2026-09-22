import type {
  AssessmentSource,
  Id,
  MasterySnapshot,
  Node,
  NodeReview,
  ReviewGrade,
} from '@/domain/models'
import { masteryAfterGrade, nextReview } from './schedule'
import type { ReviewItemResult } from './session'

/**
 * 一次复习评分的纯计算：评分前基准 → 评分后的节点补丁，外加可撤销的确认记录。
 *
 * 为什么把「评分」写成纯函数：真正的写入必须在一个事务里完成（节点 + 同步台账 +
 * 会话记录），事务里不能有网络调用、也不该有第二套算法。于是这里只算，仓储只写。
 *
 * 三条不变量：
 * 1. **从评分前基准重算**：绝不在已评过的结果上再叠一层（叠加会让一次改判被
 *    FSRS 当成两次复习，`reps` 多算、`again` 的 `lapses` 留在卡上、due 被推远）；
 * 2. **复习评分不改 `mastery.updatedAt`**：它是「摘要与薄弱点是哪次评估得出的」，
 *    被一次评分刷成刚刚，等于把评估依据伪造成当前时间；
 * 3. **撤销要能核对**：确认记录里存下写入前的完整快照与卡片，撤销时先核对当前值
 *    还是本次写入的值，不是就不许覆盖。
 */

export interface GradeWrite {
  /** 写入节点的补丁（配合 node.id 使用） */
  patch: Partial<Node>
  result: ReviewItemResult
}

/** 掌握度与卡片的比对指纹：撤销前用它核对外部是否已经改过。 */
function cardFingerprint(review: NodeReview | undefined): string | null {
  if (!review) return null
  const { card } = review
  return [
    card.due,
    card.stability,
    card.difficulty,
    card.scheduledDays,
    card.learningSteps,
    card.reps,
    card.lapses,
    card.state,
    card.lastReview ?? 0,
    review.lastGrade ?? '',
  ].join(':')
}

/** 当前掌握 / 排期是否仍是这次评分写下的值（撤销前的并发核对）。 */
export function matchesWrittenState(node: Node, result: ReviewItemResult): boolean {
  return (
    node.mastery?.score === result.masteryAfter.score &&
    cardFingerprint(node.review) === cardFingerprint(result.cardAfter)
  )
}

/**
 * 写入一次评分。
 *
 * `operationId` 由调用方在**第一次尝试之前**生成并持久化：重试同一个操作 ID
 * 必须直接返回上次结果（幂等），否则「写成功了但界面没收到」会变成第二次评分。
 */
export function gradeNode(
  node: Node,
  grade: ReviewGrade,
  operationId: Id,
  now: number,
): GradeWrite {
  const baseMastery = node.mastery ? { ...node.mastery } : undefined
  const baseCard = node.review ? { ...node.review, card: { ...node.review.card } } : null
  const baseScore = baseMastery?.score ?? 50

  // 分数只做展示：按档位给固定步长修正（保留 AI 给的薄弱点，它们仍是最近一次评估的结果）
  const mastery: MasterySnapshot = {
    ...(baseMastery ?? { updatedAt: now }),
    score: masteryAfterGrade(baseScore, grade),
    updatedAt: baseMastery?.updatedAt ?? now,
    gradedAt: now,
  }

  const review = nextReview(baseCard ?? undefined, grade, now)

  // 复习反馈是「最近一次状态变化」的来源；AI 评估的时间与依据原样保留
  const assessmentMeta = {
    ...(node.assessmentMeta ?? {}),
    source: 'review' as AssessmentSource,
  }

  const patch: Partial<Node> = {
    mastery,
    review,
    assessmentMeta,
    // 走过复习流程的主题必须显式在计划里，否则下次同步/重载后它可能又「未加入」
    reviewEnrollment: 'enabled',
    updatedAt: now,
  }

  return {
    patch,
    result: {
      operationId,
      confirmedAt: now,
      grade,
      ...(baseMastery ? { baseMastery } : {}),
      baseCard,
      baseUpdatedAt: node.updatedAt,
      ...(node.reviewEnrollment ? { baseEnrollment: node.reviewEnrollment } : {}),
      ...(node.assessmentMeta?.source ? { baseAssessmentSource: node.assessmentMeta.source } : {}),
      masteryAfter: mastery,
      cardAfter: review,
    },
  }
}

export interface UndoWrite {
  patch: Partial<Node>
}

/**
 * 撤销一次评分。
 *
 * 返回 `null` 表示**不能撤销**：节点现在掌握度 / 卡片已经不是这次评分写下的值
 * （同步、另一个标签页或本地学习动作改过），用旧快照覆盖会把新记录抹掉。
 * 只恢复本次改动过的字段，标题、笔记、摘要、位置一概不碰。
 */
export function undoGrade(node: Node, result: ReviewItemResult, now: number): UndoWrite | null {
  if (node.mastery?.score !== result.masteryAfter.score) return null
  if (cardFingerprint(node.review) !== cardFingerprint(result.cardAfter)) return null

  const patch: Partial<Node> = { updatedAt: now }
  // 评分前没有的值就恢复成「没有」（显式 undefined，归一化读回时等同缺省）：
  // 撤销一次「本来没有掌握度的节点上的评分」不该留下 50 分
  patch.mastery = result.baseMastery ? { ...result.baseMastery } : undefined
  patch.review = result.baseCard ? { ...result.baseCard, card: { ...result.baseCard.card } } : undefined
  patch.reviewEnrollment = result.baseEnrollment
  patch.assessmentMeta = {
    ...(node.assessmentMeta ?? {}),
    source: result.baseAssessmentSource ?? 'historical',
  }
  return { patch }
}