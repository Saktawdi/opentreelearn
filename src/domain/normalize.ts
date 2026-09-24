import { createDefaultSettings, clampAgentMaxSteps, clampContextBudget } from './defaults'
import type {
  AssessmentMeta,
  AssessmentSource,
  CustomModelConfig,
  GlobalSettings,
  MasterySnapshot,
  ModelRef,
  Node,
  NodeReview,
  Note,
  ProviderConfig,
  ProviderKind,
  Project,
  ReviewCard,
  ReviewCardState,
} from './models'
import { isReviewGrade } from './models'
import { normalizeNoteBody, normalizeNoteLabels } from './notes'

/**
 * 存储读回边界的数据归一化。
 *
 * 为什么需要它：IndexedDB 里的记录是没有 schema 约束的历史数据 —— 旧版本写入的、
 * 手工改过的、导入 `.tree` 时字段缺失的，都会以「类型上合法、运行时缺字段」的形态
 * 回到内存里。UI 层于是到处 `.map` / `.length` 直接访问嵌套字段，一条坏记录就能在
 * 渲染期抛出 TypeError；没有 error boundary 时整棵 React 树会被卸载成白屏。
 *
 * 与其在每个 UI 调用点补 `?? []`（既散落、又会让 UI 层承担存储契约），不如在
 * `data` 读取边界一次性收敛：读出来的对象保证是完整形状，上层可以放心直接访问。
 *
 * 本模块是纯函数，只依赖 `domain` 内部类型与默认值，不碰存储 / React / 网络。
 */

const PROVIDER_KINDS: readonly ProviderKind[] = [
  'openai',
  'anthropic',
  'google',
  'openai-compatible',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 只接受有限数值；其余（含数字字符串）一律回退，避免把隐式转换的坑带进业务层。 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 过滤非字符串、去空白、丢空串 —— 与 `collectTags` / `ModelPicker` 的口径保持一致。 */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed) result.push(trimmed)
  }
  return result
}

export function normalizeModelRef(value: unknown): ModelRef | null {
  if (!isRecord(value)) return null
  const providerId = readString(value.providerId)
  const modelId = readString(value.modelId)
  if (!providerId || !modelId) return null
  return { providerId, modelId }
}

function normalizeCustomModelConfig(value: unknown): CustomModelConfig | undefined {
  if (!isRecord(value)) return undefined
  const contextLimit = readOptionalNumber(value.contextLimit)
  const hasVision = typeof value.hasVision === 'boolean' ? value.hasVision : undefined
  const reasoning = typeof value.reasoning === 'boolean' ? value.reasoning : undefined
  const reasoningLevels = Array.isArray(value.reasoningLevels)
    ? readStringArray(value.reasoningLevels)
    : undefined

  if (
    contextLimit === undefined &&
    hasVision === undefined &&
    reasoning === undefined &&
    (reasoningLevels === undefined || reasoningLevels.length === 0)
  ) {
    return undefined
  }

  return {
    ...(contextLimit !== undefined ? { contextLimit } : {}),
    ...(hasVision !== undefined ? { hasVision } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(reasoningLevels && reasoningLevels.length > 0 ? { reasoningLevels } : {}),
  }
}

function normalizeModelConfigs(value: unknown): Record<string, CustomModelConfig> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, CustomModelConfig> = {}
  let count = 0
  for (const [modelId, config] of Object.entries(value)) {
    const trimmedId = modelId.trim()
    if (!trimmedId) continue
    const normalized = normalizeCustomModelConfig(config)
    if (normalized) {
      result[trimmedId] = normalized
      count += 1
    }
  }
  return count > 0 ? result : undefined
}

export function normalizeProvider(value: unknown): ProviderConfig | null {
  if (!isRecord(value)) return null
  const id = readString(value.id)
  if (!id) return null

  const kind = PROVIDER_KINDS.includes(value.kind as ProviderKind)
    ? (value.kind as ProviderKind)
    : 'openai-compatible'

  // 能力位：只有明确的布尔值才算「探测过」；坏值一律退回未探测（undefined）
  const capabilities = isRecord(value.capabilities)
    ? typeof value.capabilities.tools === 'boolean'
      ? { tools: value.capabilities.tools as boolean }
      : undefined
    : undefined

  // 推理强度是自由文本：去空白即可，非空才落（'auto' 也是合法值，见 ProviderConfig）
  const reasoningEffort = readString(value.reasoningEffort)?.trim()

  const modelConfigs = normalizeModelConfigs(value.modelConfigs)

  return {
    id,
    label: readString(value.label) ?? '未命名提供商',
    kind,
    apiKey: readString(value.apiKey) ?? '',
    baseURL: readString(value.baseURL),
    models: readStringArray(value.models),
    ...(capabilities ? { capabilities } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(modelConfigs ? { modelConfigs } : {}),
  }
}

export function normalizeProject(value: unknown, now = Date.now()): Project | null {
  if (!isRecord(value)) return null
  const id = readString(value.id)
  if (!id) return null

  const createdAt = readNumber(value.createdAt, now)

  return {
    id,
    name: readString(value.name) ?? '未命名项目',
    description: readString(value.description),
    tags: readStringArray(value.tags),
    createdAt,
    updatedAt: readNumber(value.updatedAt, createdAt),
  }
}

/**
 * 标注的读回归一化。
 *
 * `start` / `end` 决定这段标注画在正文的哪一段上，坏值（负的、倒置的、非数值的）
 * 会让渲染期的 Range 直接抛错，所以这里一律夹紧：起点不为负，终点不早于起点。
 * 缺少 `projectId` / `nodeId` / `messageId` 的记录无法归属到任何消息，也就永远
 * 渲染不出来，直接丢弃而不是留在库里越积越多。
 *
 * 旧数据的 `kind` 字段在这里被丢掉、不做映射：`annotation` + body 读出来就是
 * `{ labels: [], body }`（标签为空、内容不丢），`highlight` 读出来是
 * `{ labels: [] }` —— 两者都退化成「纯高亮」，只是前者仍带着备注。这正是
 * 演进方案要的语义：老标注不丢内容，只是不再假装自己带语义标签。
 */
export function normalizeNote(value: unknown, now = Date.now()): Note | null {
  if (!isRecord(value)) return null

  const id = readString(value.id)
  const projectId = readString(value.projectId)
  const nodeId = readString(value.nodeId)
  const messageId = readString(value.messageId)
  if (!id || !projectId || !nodeId || !messageId) return null

  const quote = readString(value.quote) ?? ''
  const start = Math.max(0, Math.floor(readNumber(value.start, 0)))
  const end = Math.max(start, Math.floor(readNumber(value.end, start + quote.length)))
  const createdAt = readNumber(value.createdAt, now)
  const body = normalizeNoteBody(value.body)

  return {
    id,
    projectId,
    nodeId,
    messageId,
    labels: normalizeNoteLabels(value.labels),
    quote,
    start,
    end,
    ...(body ? { body } : {}),
    createdAt,
    updatedAt: readNumber(value.updatedAt, createdAt),
  }
}

/** 掌握度分数只认 0-100 的有限数值；其余一律夹紧，不把 NaN / 越界值带进聚合。 */
function clampScore(value: number): number {
  return Math.min(Math.max(Math.round(value), 0), 100)
}

const REVIEW_CARD_STATES: readonly ReviewCardState[] = [
  'new',
  'learning',
  'review',
  'relearning',
]

/**
 * 掌握度快照的读回归一化。
 *
 * 缺 `updatedAt` 时退回 0 而不是丢弃：一个没有时间的分数会被当成「很旧」，
 * 而丢弃会让用户已经生成过的分数凭空消失 —— 前者是弱化显示，后者是数据丢失。
 */
export function normalizeMastery(value: unknown): MasterySnapshot | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.score !== 'number' || !Number.isFinite(value.score)) return undefined

  const weakPoints = readStringArray(value.weakPoints).slice(0, 3)

  const gradedAt = readOptionalNumber(value.gradedAt)

  return {
    score: clampScore(value.score),
    ...(weakPoints.length > 0 ? { weakPoints } : {}),
    updatedAt: readNumber(value.updatedAt, 0),
    ...(gradedAt !== undefined ? { gradedAt } : {}),
  }
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const ASSESSMENT_SOURCES: readonly AssessmentSource[] = ['ai', 'review', 'historical']

/**
 * 学习评估来源的读回归一化。
 *
 * 来源认不出来时退化成 `historical`：**不根据分数猜**它是 AI 评估还是复习评分
 * —— 猜错等于给用户看一段假的依据。时间与指纹缺失一律留空（没有依据就说没有）。
 */
export function normalizeAssessmentMeta(value: unknown): AssessmentMeta | undefined {
  if (!isRecord(value)) return undefined
  const source = ASSESSMENT_SOURCES.includes(value.source as AssessmentSource)
    ? (value.source as AssessmentSource)
    : 'historical'
  const assessedAt = readOptionalNumber(value.assessedAt)
  const basedOnStudiedAt = readOptionalNumber(value.basedOnStudiedAt)
  const basedOnPath = readString(value.basedOnPath)

  return {
    source,
    ...(assessedAt !== undefined ? { assessedAt } : {}),
    ...(basedOnStudiedAt !== undefined ? { basedOnStudiedAt } : {}),
    ...(basedOnPath ? { basedOnPath } : {}),
  }
}

/**
 * 复习卡片的读回归一化。
 *
 * 卡片是一个整体：任一关键字段坏掉都不能只修一半 —— 半张卡会让 FSRS 用
 * 错误的 stability / state 排期，宁可整张丢掉（下一轮复习时重新建卡）。
 */
export function normalizeReview(value: unknown): NodeReview | undefined {
  if (!isRecord(value)) return undefined
  const card = isRecord(value.card) ? value.card : null
  if (!card) return undefined

  const due = readOptionalNumber(card.due)
  const stability = readOptionalNumber(card.stability)
  const difficulty = readOptionalNumber(card.difficulty)
  const scheduledDays = readOptionalNumber(card.scheduledDays)
  const learningSteps = readOptionalNumber(card.learningSteps)
  const reps = readOptionalNumber(card.reps)
  const lapses = readOptionalNumber(card.lapses)
  if (
    due === undefined ||
    stability === undefined ||
    difficulty === undefined ||
    scheduledDays === undefined ||
    learningSteps === undefined ||
    reps === undefined ||
    lapses === undefined
  ) {
    return undefined
  }

  const state = REVIEW_CARD_STATES.includes(card.state as ReviewCardState)
    ? (card.state as ReviewCardState)
    : 'new'
  const lastReview = readOptionalNumber(card.lastReview)

  const normalizedCard: ReviewCard = {
    due,
    stability,
    difficulty,
    scheduledDays,
    learningSteps,
    reps: Math.max(0, Math.floor(reps)),
    lapses: Math.max(0, Math.floor(lapses)),
    state,
    ...(lastReview !== undefined ? { lastReview } : {}),
  }

  return {
    card: normalizedCard,
    ...(isReviewGrade(value.lastGrade) ? { lastGrade: value.lastGrade } : {}),
  }
}

/**
 * 节点的读回归一化。
 *
 * 与笔记不同，节点**永远不丢**：缺 `id` / `projectId` 才拒绝。新加的可选字段
 * （kind / mastery / review / lastStudiedAt）在这里兜底，坏数据退化成缺省行为
 * （没有掌握度、没有复习排期），不会让画布或复习队列崩掉。
 */
export function normalizeNode(value: unknown): Node | null {
  if (!isRecord(value)) return null
  const id = readString(value.id)
  const projectId = readString(value.projectId)
  if (!id || !projectId) return null

  const createdAt = readNumber(value.createdAt, Date.now())
  // 坐标要么是完整可用的两个数（= 用户手动摆过，锁定），要么退化成自动布局；
  // 半个坐标补 0 会把节点悄悄钉到原点上
  const position =
    isRecord(value.position) &&
    typeof value.position.x === 'number' &&
    Number.isFinite(value.position.x) &&
    typeof value.position.y === 'number' &&
    Number.isFinite(value.position.y)
      ? { x: value.position.x, y: value.position.y }
      : null

  return {
    id,
    projectId,
    parentId: typeof value.parentId === 'string' ? value.parentId : null,
    forkFrom: isRecord(value.forkFrom) ? (value.forkFrom as unknown as Node['forkFrom']) : null,
    title: readString(value.title) ?? '未命名节点',
    summary: readString(value.summary),
    contextSeed: Array.isArray(value.contextSeed) ? readStringArray(value.contextSeed) : undefined,
    position,
    status: value.status === 'archived' ? 'archived' : 'active',
    thread: isRecord(value.thread) ? (value.thread as unknown as Node['thread']) : undefined,
    kind: value.kind === 'review' ? 'review' : value.kind === 'topic' ? 'topic' : undefined,
    mastery: normalizeMastery(value.mastery),
    review: normalizeReview(value.review),
    ...(value.reviewEnrollment === 'enabled' || value.reviewEnrollment === 'disabled'
      ? { reviewEnrollment: value.reviewEnrollment }
      : {}),
    assessmentMeta: normalizeAssessmentMeta(value.assessmentMeta),
    lastStudiedAt: readOptionalNumber(value.lastStudiedAt),
    createdAt,
    updatedAt: readNumber(value.updatedAt, createdAt),
  }
}

export function normalizeGlobalSettings(value: unknown): GlobalSettings {
  const defaults = createDefaultSettings()
  if (!isRecord(value)) return defaults

  return {
    backgroundProfile: readString(value.backgroundProfile) ?? defaults.backgroundProfile,
    defaultChatModelRef: normalizeModelRef(value.defaultChatModelRef),
    titleModelRef: normalizeModelRef(value.titleModelRef),
    summaryModelRef: normalizeModelRef(value.summaryModelRef),
    contextBudget: clampContextBudget(
      readNumber(value.contextBudget, defaults.contextBudget),
    ),
    agentMaxSteps: clampAgentMaxSteps(readNumber(value.agentMaxSteps, defaults.agentMaxSteps)),
    providers: Array.isArray(value.providers)
      ? value.providers
          .map(normalizeProvider)
          .filter((provider): provider is ProviderConfig => provider !== null)
      : [],
    updatedAt: readNumber(value.updatedAt, defaults.updatedAt),
  }
}
