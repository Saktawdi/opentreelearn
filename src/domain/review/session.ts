import type {
  AssessmentSource,
  Id,
  MasterySnapshot,
  ModelRef,
  NodeReview,
  ReviewEnrollment,
  ReviewGrade,
} from '@/domain/models'
import { newId } from '@/lib/id'
import type { ReviewMode, ReviewQueueItem } from './queue'

/**
 * 复习会话的领域模型与状态迁移（纯函数）。
 *
 * 旧实现用 `cursor` + `finishedAt` + 几个布尔值拼出流程，隐含状态太多：
 * 「正在出题」「等回答」「已评分但没前进」在数据上长得一模一样，
 * 刷新恢复时只能靠猜。这里把**会话状态**与**当前项阶段**分开成两个显式枚举，
 * 任何界面分支都只需要读一个字段。
 *
 * 纯逻辑、无 IO：持久化在 `data`，请求在 `services/llm/review`，
 * UI 状态在 `stores/review-session-store`。这样状态迁移可以单独测试。
 */

/** 会话文档结构版本；无法识别的版本保留内容但不再恢复（见 data 层）。 */
export const REVIEW_SESSION_SCHEMA_VERSION = 1

export type ReviewSessionStatus =
  /** 正在进行 */
  | 'active'
  /** 用户「稍后继续」离开，可从保存的阶段恢复 */
  | 'paused'
  /** 本批所有项都已评分 / 跳过 / 不可用 —— 完成的是批次流程，不表示全部掌握 */
  | 'completed'
  /** 用户主动「结束本次」，剩余项未完成 */
  | 'ended'

export type ReviewItemPhase =
  /** 正在生成题目 / 补学内容 */
  | 'preparing'
  /** 补学：关键点已展示，等用户确认后出复述题 */
  | 'relearning'
  /** 题目已给出，等用户回答 */
  | 'answering'
  /** 正在生成反馈 */
  | 'evaluating'
  /** 反馈已给出，等用户选择档位并确认 */
  | 'feedback'
  /** 正在保存评分 */
  | 'saving'
  /** 本项已完成（已确认评分） */
  | 'done'
  /** 本项被跳过：不改掌握度、不推进排期 */
  | 'skipped'
  /** 本项在本次会话中已不可用（节点被删除 / 归档 / 移出计划） */
  | 'unavailable'

/**
 * 一次模型请求的用途。
 *
 * 用途决定了两件事：**上下文怎么组装**，以及**输出里的评分标记算不算数**。
 * 只有 `answer`（对用户回答的反馈）与 `followup`（围绕同一次回答的追问）
 * 才可能携带有效建议 —— 出题、提示、补学里出现的 `[[rating:...]]` 一律无效。
 */
export type ReviewRequestPurpose =
  | 'question'
  | 'relearn'
  | 'hint'
  | 'rephrase'
  | 'answer'
  | 'followup'

export interface ReviewSessionMessage {
  id: Id
  role: 'user' | 'assistant'
  text: string
  purpose: ReviewRequestPurpose
  /** 产生这条消息的请求 id；迟到回调据此被丢弃 */
  requestId?: Id
  /** 生成被中断或失败：正文保留但**不采纳其中的评分标记** */
  incomplete?: boolean
  /** 失败原因（内联重试提示用） */
  error?: string
  createdAt: number
}

/**
 * 一次确认的完整记录。
 *
 * `base*` 是**评分前**的基准：撤销与改判都从它重算，而不是在已评过的结果上再叠一层
 * （叠加会让一次改判被 FSRS 当成两次复习）。`baseUpdatedAt` 用于并发核对：
 * 同步或另一个标签页改过节点时，不允许用旧快照覆盖新状态。
 */
export interface ReviewItemResult {
  /** 幂等键：同一操作重试只生效一次 */
  operationId: Id
  confirmedAt: number
  grade: ReviewGrade
  baseMastery?: MasterySnapshot
  baseCard: NodeReview | null
  baseUpdatedAt: number
  /** 评分前的计划开关（没写过就是 undefined），撤销时原样恢复 */
  baseEnrollment?: ReviewEnrollment
  /** 评分前的状态来源（撤销时恢复，避免把「AI 评估」的历史说成「复习反馈」） */
  baseAssessmentSource?: AssessmentSource
  masteryAfter: MasterySnapshot
  cardAfter: NodeReview
}

export interface ReviewSessionItem {
  itemId: Id
  nodeId: Id
  /** 标题快照：节点之后被改名或删除，小结与历史记录仍读得通 */
  title: string
  mode: ReviewMode
  phase: ReviewItemPhase
  /** 资料版本标识（进入本项时可见路径的指纹） */
  sourceVersion?: string
  /** 本次经预算裁剪后**实际使用**的资料文本；原版本被淘汰后仍可查看 */
  sourceText?: string
  messages: ReviewSessionMessage[]
  /** 输入草稿：暂停 / 刷新后继续编辑 */
  draft?: string
  /** 已提交的回答；反馈阶段要保留它 */
  answer?: string
  /** 用户主动交互过（答题、看提示、换问法、确认复述）—— 撤销窗口的判据 */
  interacted?: boolean
  /** 结束本项时节点使用的模型 */
  modelRef?: ModelRef
  /** 本次参考过提示 / 资料：只做轻量说明，不暗中改评分 */
  usedHint?: boolean
  usedSource?: boolean
  selectedGrade?: ReviewGrade
  result?: ReviewItemResult
  /** 跳过原因（用户主动跳过 / 节点不可用） */
  skipReason?: string
  /** 阶段级错误：保留上一个稳定状态与用户内容，允许重试 */
  error?: string
  /** 进行中的请求：刷新恢复时据此显示「上次生成已中断」 */
  pendingRequestId?: Id
  pendingPurpose?: ReviewRequestPurpose
  /**
   * 进入「保存中」时就固定下来的操作 ID。
   *
   * 保存被中断（刷新、断网）后重试必须复用同一个 ID，否则「写进去了但界面没收到
   * 成功」会变成第二次评分 —— 幂等键要在第一次尝试**之前**生成并落库。
   */
  pendingOperationId?: Id
  updatedAt: number
}

/** 返回学习时要恢复的位置。 */
export interface ReviewReturnTarget {
  nodeId?: Id
  viewMode?: 'chat' | 'canvas'
  /** 对话滚动位置（像素），恢复后尽可能回到原处 */
  scrollTop?: number
}

export interface ReviewSessionRecord {
  id: Id
  schemaVersion: number
  projectId: Id
  status: ReviewSessionStatus
  /** 递增版本：每次落库 +1，用于迟到写入与并发校验 */
  version: number
  /** 从哪进来的：概览选批 / 单个节点 */
  origin: 'overview' | 'node'
  returnTo?: ReviewReturnTarget
  items: ReviewSessionItem[]
  /** 当前项下标；等于 items.length 表示没有未处理项 */
  cursor: number
  createdAt: number
  updatedAt: number
  finishedAt?: number
  /** 需要一次性告知用户的说明（撤销被拒、节点失效等） */
  notice?: string
}

export interface ReviewSessionSeed {
  nodeId: Id
  title: string
  mode: ReviewMode
  sourceVersion?: string
}

export interface CreateSessionParams {
  projectId: Id
  items: ReviewSessionSeed[]
  origin: ReviewSessionRecord['origin']
  returnTo?: ReviewReturnTarget
  id?: Id
  now?: number
}

export function createReviewSession(params: CreateSessionParams): ReviewSessionRecord {
  const now = params.now ?? Date.now()
  return {
    id: params.id ?? newId(),
    schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
    projectId: params.projectId,
    status: 'active',
    version: 1,
    origin: params.origin,
    ...(params.returnTo ? { returnTo: params.returnTo } : {}),
    items: params.items.map((seed) => ({
      itemId: newId(),
      nodeId: seed.nodeId,
      title: seed.title,
      mode: seed.mode,
      phase: 'preparing' as ReviewItemPhase,
      ...(seed.sourceVersion ? { sourceVersion: seed.sourceVersion } : {}),
      messages: [],
      updatedAt: now,
    })),
    cursor: 0,
    createdAt: now,
    updatedAt: now,
  }
}

export function currentItem(session: ReviewSessionRecord | null): ReviewSessionItem | null {
  if (!session) return null
  return session.items[session.cursor] ?? null
}

export function itemOf(
  session: ReviewSessionRecord | null,
  itemId: Id,
): ReviewSessionItem | null {
  return session?.items.find((item) => item.itemId === itemId) ?? null
}

export interface SessionProgress {
  total: number
  /** 已确认评分的项 */
  done: number
  skipped: number
  unavailable: number
  /** 尚未处理（含当前项） */
  remaining: number
  /** 已完成 + 跳过 + 不可用 */
  processed: number
}

export function sessionProgress(session: ReviewSessionRecord | null): SessionProgress {
  const items = session?.items ?? []
  let done = 0
  let skipped = 0
  let unavailable = 0
  for (const item of items) {
    if (item.phase === 'done') done += 1
    else if (item.phase === 'skipped') skipped += 1
    else if (item.phase === 'unavailable') unavailable += 1
  }
  const processed = done + skipped + unavailable
  return {
    total: items.length,
    done,
    skipped,
    unavailable,
    remaining: items.length - processed,
    processed,
  }
}

/** 下一项：跳过已处理项，返回第一个还没处理完的项（含当前项）。 */
export function nextPendingIndex(
  session: ReviewSessionRecord,
  from = session.cursor,
): number {
  for (let i = from; i < session.items.length; i += 1) {
    const phase = session.items[i].phase
    if (phase === 'done' || phase === 'skipped' || phase === 'unavailable') continue
    return i
  }
  return session.items.length
}

/** 是否已经处理完所有项；调用方据此把会话置为 completed。 */
export function isExhausted(session: ReviewSessionRecord): boolean {
  return nextPendingIndex(session, 0) >= session.items.length
}

/** 未处理完的项数（给「还有 N 个未完成」用）。 */
export function pendingCount(session: ReviewSessionRecord, from = 0): number {
  let count = 0
  for (let i = from; i < session.items.length; i += 1) {
    const phase = session.items[i].phase
    if (phase === 'done' || phase === 'skipped' || phase === 'unavailable') continue
    count += 1
  }
  return count
}

export interface ItemPatch {
  phase?: ReviewItemPhase
  draft?: string
  answer?: string
  interacted?: boolean
  usedHint?: boolean
  usedSource?: boolean
  selectedGrade?: ReviewGrade | undefined
  result?: ReviewItemResult
  skipReason?: string
  error?: string
  pendingRequestId?: Id | undefined
  pendingPurpose?: ReviewRequestPurpose | undefined
  pendingOperationId?: Id | undefined
  messages?: ReviewSessionMessage[]
  sourceVersion?: string
  sourceText?: string
  modelRef?: ModelRef
}

/**
 * 更新一项并推进指针。
 *
 * 指针**只向前到下一个未处理项**：某项被跳过或评分后，指针落到它后面第一个
 * 还没处理完的项上 —— 中途回头补做（撤销后退回上一项）由调用方显式设置 cursor。
 */
export function patchItem(
  session: ReviewSessionRecord,
  itemId: Id,
  patch: ItemPatch,
  now: number,
): void {
  const item = session.items.find((entry) => entry.itemId === itemId)
  if (!item) return
  const { phase, ...rest } = patch
  Object.assign(item, rest)
  if (phase) item.phase = phase
  if (patch.selectedGrade === undefined && 'selectedGrade' in patch) delete item.selectedGrade
  if (patch.pendingRequestId === undefined && 'pendingRequestId' in patch) delete item.pendingRequestId
  if (patch.pendingPurpose === undefined && 'pendingPurpose' in patch) delete item.pendingPurpose
  if (patch.pendingOperationId === undefined && 'pendingOperationId' in patch) {
    delete item.pendingOperationId
  }
  item.updatedAt = now
  session.updatedAt = now
  session.version += 1
}

/**
 * 一项处理完（评分 / 跳过 / 不可用）之后推进指针。
 *
 * 全部处理完 ⇒ 会话转为 `completed`。这不是「全部掌握」，只是「这一批走完了」。
 */
export function advanceAfter(
  session: ReviewSessionRecord,
  itemId: Id,
  now: number,
): void {
  const index = session.items.findIndex((entry) => entry.itemId === itemId)
  if (index < 0) return
  session.cursor = nextPendingIndex(session, index + 1)
  session.updatedAt = now
  session.version += 1
  if (session.cursor >= session.items.length) {
    session.status = 'completed'
    session.finishedAt = now
  }
}

/** 当前项是否允许确认评分：只有回答了、拿到反馈之后才能写排期。 */
export function canConfirm(item: ReviewSessionItem | null): boolean {
  if (!item) return false
  return item.phase === 'feedback' && Boolean(item.answer?.trim())
}

/** 会话是否可以暂停（保存当前进度后离开）。 */
export function pauseSession(session: ReviewSessionRecord, now: number): void {
  if (session.status === 'active') {
    session.status = 'paused'
    session.updatedAt = now
    session.version += 1
  }
}

/**
 * 恢复：只有 paused 的会话回到 active。
 *
 * 上次离开时正在进行的请求已经不存在了：把阶段退回**可重试的稳定态**并留下说明，
 * 由用户决定什么时候重试 —— 自动重发等于替用户再付一次模型调用。
 */
export function resumeSession(session: ReviewSessionRecord, now: number): void {
  if (session.status !== 'paused') return
  session.status = 'active'
  session.updatedAt = now
  session.version += 1
  recoverInterrupted(session, now)
}

/**
 * 载入会话时调用：把「上次中断的请求」退回可重试的稳定态。
 *
 * 刷新后恢复的会话状态是 `active` 也一样 —— 页面重载后没有任何在途请求，
 * 停在进行中的阶段只会让界面一直转圈。
 */
export function recoverSession(session: ReviewSessionRecord, now: number): void {
  if (session.status === 'completed' || session.status === 'ended') return
  recoverInterrupted(session, now)
}

function recoverInterrupted(session: ReviewSessionRecord, now: number): void {
  const item = session.items[session.cursor]
  if (!item) return
  if (item.phase === 'preparing') {
    item.error = '上次生成已中断'
  } else if (item.phase === 'evaluating') {
    // 回答已经提交过，退回「已提交、等反馈」的可重试状态
    item.phase = 'answering'
    item.error = '上次生成已中断'
  } else if (item.phase === 'saving') {
    // 保存可能已经落库也可能没有：重试走同一个操作 ID，幂等
    item.phase = 'feedback'
    item.error = '上次保存已中断，请再次确认'
  } else {
    return
  }
  item.pendingRequestId = undefined
  item.pendingPurpose = undefined
  item.updatedAt = now
  session.updatedAt = now
}

/** 用户主动「结束本次」：保留已确认结果，剩余项记为未完成。 */
export function endSession(session: ReviewSessionRecord, now: number): void {
  session.status = 'ended'
  session.finishedAt = now
  session.updatedAt = now
  session.version += 1
}

/**
 * 把在途请求留下的中间态退回稳定态（暂停、结束、离开模式时调用）。
 *
 * 只动**没有用户内容可丢**的部分：草稿、回答、反馈一律原样保留。
 * 「结束本次」的剩余项保持未完成阶段 —— 小结要如实显示「未完成 2」，
 * 把它们标成「跳过」会把用户对整批的选择说成对每一项的选择。
 */
export function settlePendingItems(session: ReviewSessionRecord, now: number): void {
  for (const item of session.items) {
    if (item.phase !== 'preparing' && item.phase !== 'evaluating' && item.phase !== 'saving') {
      continue
    }
    item.phase = item.phase === 'evaluating' ? 'answering' : item.phase === 'saving' ? 'feedback' : 'preparing'
    item.pendingRequestId = undefined
    item.pendingPurpose = undefined
    item.updatedAt = now
  }
  session.updatedAt = now
}

/**
 * 「结束本次」：保留已确认结果，剩余项记为未完成。
 *
 * 与「跳过」区分开 —— 跳过是用户对**这一项**的选择，结束是对**整批**的选择，
 * 小结里的计数不能把两者混成一个数字。
 */
export function endSessionWithPending(session: ReviewSessionRecord, now: number): void {
  settlePendingItems(session, now)
  endSession(session, now)
}

/**
 * 可以撤销的那一次确认。
 *
 * 窗口规则（直接来自验收要求）：其后**没有更晚的用户进展** —— 下一项若已经
 * 提交过回答、主动交互过或已确认，撤销入口关闭；仅自动展示的补学内容不算交互。
 * `ended` 的会话不提供撤销：用户已经明确结束，剩下的是「未完成」，不是「可回退」。
 */
export function undoableItem(session: ReviewSessionRecord | null): ReviewSessionItem | null {
  if (!session || session.status === 'ended') return null
  let index = -1
  for (let i = 0; i < session.items.length; i += 1) {
    if (!session.items[i].result) continue
    if (index < 0 || session.items[i].result!.confirmedAt >= session.items[index].result!.confirmedAt) {
      index = i
    }
  }
  if (index < 0) return null
  for (let i = index + 1; i < session.items.length; i += 1) {
    const item = session.items[i]
    if (item.result || item.answer || item.interacted) return null
  }
  return session.items[index]
}

/** 撤销：清掉该项的结果并把指针退回它，恢复成「等待确认」的反馈阶段。 */
export function undoConfirm(
  session: ReviewSessionRecord,
  itemId: Id,
  now: number,
): ReviewSessionItem | null {
  const item = session.items.find((entry) => entry.itemId === itemId)
  if (!item?.result) return null
  item.result = undefined
  item.selectedGrade = undefined
  item.phase = 'feedback'
  item.updatedAt = now
  session.cursor = session.items.indexOf(item)
  if (session.status === 'completed' || session.status === 'paused') session.status = 'active'
  session.finishedAt = undefined
  session.updatedAt = now
  session.version += 1
  return item
}

export interface SessionSummaryRow {
  itemId: Id
  nodeId: Id
  title: string
  outcome: 'done' | 'skipped' | 'unavailable' | 'unfinished'
  grade?: ReviewGrade
  nextDue?: number
  /**
   * 待巩固点。
   *
   * 只取**已经记在数据里的来源**（该次确认写入的掌握度快照带的薄弱点，来自最近一次
   * 学习评估）；没有来源就不给这一项 —— 小结里编不出「本次的薄弱点」，
   * 反馈失败的项更不能凭空生成总结。
   */
  weakPoints?: string[]
  /** 薄弱点的来源说明，例如「上次学习评估」 */
  weakPointsSource?: string
}

export interface SessionSummary {
  rows: SessionSummaryRow[]
  done: number
  skipped: number
  unavailable: number
  unfinished: number
}

const WEAK_POINTS_SOURCE = '上次学习评估'

/** 小结数据；`nextDue` 取该次确认写入的卡片到期时间（真实排期，不是估算）。 */
export function sessionSummary(session: ReviewSessionRecord): SessionSummary {
  const rows: SessionSummaryRow[] = session.items.map((item) => {
    const points = item.result?.masteryAfter.weakPoints ?? []
    // 只对「这次没答好」的项提示待巩固点：全对的主题上再列旧薄弱点只会制造焦虑
    const worthShowing =
      points.length > 0 && (item.result?.grade === 'again' || item.result?.grade === 'hard')
    return {
      itemId: item.itemId,
      nodeId: item.nodeId,
      title: item.title,
      outcome: item.result
        ? 'done'
        : item.phase === 'skipped'
          ? 'skipped'
          : item.phase === 'unavailable'
            ? 'unavailable'
            : 'unfinished',
      ...(item.result ? { grade: item.result.grade, nextDue: item.result.cardAfter.card.due } : {}),
      ...(worthShowing
        ? { weakPoints: points, weakPointsSource: WEAK_POINTS_SOURCE }
        : {}),
    }
  })

  return {
    rows,
    done: rows.filter((row) => row.outcome === 'done').length,
    skipped: rows.filter((row) => row.outcome === 'skipped').length,
    unavailable: rows.filter((row) => row.outcome === 'unavailable').length,
    unfinished: rows.filter((row) => row.outcome === 'unfinished').length,
  }
}

/** 一批队列项 → 会话种子（标题与模式来自当前节点快照）。 */
export function seedsFromQueue(
  items: ReviewQueueItem[],
  titleOf: (nodeId: Id) => string,
  versionOf: (nodeId: Id) => string | undefined,
): ReviewSessionSeed[] {
  return items.map((item) => ({
    nodeId: item.nodeId,
    title: titleOf(item.nodeId),
    mode: item.mode,
    ...(versionOf(item.nodeId) ? { sourceVersion: versionOf(item.nodeId) } : {}),
  }))
}

/** 会话文档是否可识别（版本 + 关键字段）；坏文档一律不恢复，但内容保留。 */
export function isReadableSession(value: unknown): value is ReviewSessionRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ReviewSessionRecord>
  if (record.schemaVersion !== REVIEW_SESSION_SCHEMA_VERSION) return false
  if (typeof record.id !== 'string' || typeof record.projectId !== 'string') return false
  if (!Array.isArray(record.items)) return false
  if (typeof record.cursor !== 'number') return false
  return ['active', 'paused', 'completed', 'ended'].includes(String(record.status))
}