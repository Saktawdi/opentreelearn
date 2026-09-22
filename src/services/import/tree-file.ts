import { z } from 'zod'
import type { AssessmentSource, NodeStatus, NoteKind, ReviewEnrollment } from '@/domain/models'
import { isNoteKind } from '@/domain/notes'

const rawMessageSchema = z.object({
  id: z.string().optional(),
  role: z.string(),
  content: z.union([z.string(), z.null()]).optional(),
  messageType: z.string().optional(),
  timestamp: z.coerce.number().optional(),
  context: z.array(z.string()).optional(),
  turnTitle: z.string().optional(),
  /** v2：该消息里的图片张数（图片本体不随文件走，只用来如实告知用户） */
  images: z.coerce.number().optional(),
})

const assessmentMetaSchema = z.object({
  assessedAt: z.coerce.number().optional(),
  basedOnStudiedAt: z.coerce.number().optional(),
  basedOnPath: z.string().optional(),
  source: z.string().optional(),
})

const rawCardSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  messages: z.array(rawMessageSchema).optional(),
  children: z.array(z.string()).optional(),
  depth: z.coerce.number().optional(),
  /** v2：节点真实时间；缺省（v1 / 外部文件）由导入端按消息时间或数组顺序兜底 */
  createdAt: z.coerce.number().optional(),
  updatedAt: z.coerce.number().optional(),
  /** 画布坐标 [x, y, z]；v1 文件也写过，只是以前的解析端没读 */
  position: z.array(z.coerce.number()).optional(),
  /** v2：归档标记 */
  archived: z.boolean().optional(),
  // 掌握度与复习中心的导出字段；旧文件没有，缺省即普通节点
  kind: z.string().optional(),
  mastery: z
    .object({
      score: z.coerce.number(),
      weakPoints: z.array(z.string()).optional(),
      /** v2：评估快照时间与最近评分时间；v1 文件没有，导入端退回合成时间 */
      updatedAt: z.coerce.number().optional(),
      gradedAt: z.coerce.number().optional(),
    })
    .optional(),
  /** v2：复习计划开关与评估来源 */
  reviewEnrollment: z.string().optional(),
  assessmentMeta: assessmentMetaSchema.optional(),
  /** v2：分支来源 */
  forkFrom: z
    .object({
      nodeId: z.string(),
      messageId: z.string(),
    })
    .optional(),
})

const rawNoteSchema = z.object({
  id: z.string().optional(),
  messageId: z.string(),
  kind: z.string().optional(),
  quote: z.string().optional(),
  start: z.coerce.number().optional(),
  end: z.coerce.number().optional(),
  body: z.string().optional(),
  createdAt: z.coerce.number().optional(),
  updatedAt: z.coerce.number().optional(),
})

const treeFileSchema = z.object({
  type: z.literal('project'),
  version: z.coerce.number(),
  data: z.object({
    name: z.string().optional(),
    cards: z.array(rawCardSchema),
    /** v2：笔记 */
    notes: z.array(rawNoteSchema).optional(),
    createdAt: z.coerce.number().optional(),
    updatedAt: z.coerce.number().optional(),
  }),
})

export class TreeParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TreeParseError'
  }
}

export interface ParsedMessage {
  sourceId?: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  turnTitle?: string
  /** 该消息里的图片张数；正文为空而这里有值 = 纯图片消息（不落空气泡，只计入统计） */
  images?: number
}

export interface ParsedAssessmentMeta {
  assessedAt?: number
  basedOnStudiedAt?: number
  basedOnPath?: string
  source: AssessmentSource
}

export interface ParsedCard {
  sourceId: string
  title: string
  parentSourceId: string | null
  messages: ParsedMessage[]
  contextSeed?: string[]
  status: NodeStatus
  /** 真实的创建 / 更新时间；缺省时导入端按最早消息时间兜底 —— 画布按它排布 */
  createdAt?: number
  updatedAt?: number
  position?: { x: number; y: number }
  /** 复习中心标记（`.tree` 里有 kind: 'review' 时） */
  kind?: 'review'
  /** 携带的掌握度分数与快照时间；没有复习排期（那是设备本地状态） */
  mastery?: { score: number; weakPoints?: string[]; updatedAt?: number; gradedAt?: number }
  /** 显式计划开关；缺省（v1 / 外部文件）= 未加入，不替用户打开计划 */
  reviewEnrollment?: ReviewEnrollment
  /** 评估来源；缺省时导入端按 historical 记录，不伪称本次 AI 评估 */
  assessmentMeta?: ParsedAssessmentMeta
  /** 分支来源（源节点与源消息的**文件内 id**，导入时重映射） */
  forkFrom?: { nodeSourceId: string; messageSourceId: string }
}

export interface ParsedNote {
  sourceId?: string
  messageSourceId: string
  kind: NoteKind
  quote: string
  start: number
  end: number
  body?: string
  createdAt: number
  updatedAt: number
}

export interface ParsedProject {
  name: string
  createdAt: number
  updatedAt: number
  cards: ParsedCard[]
  notes: ParsedNote[]
  stats: {
    cards: number
    messages: number
    roots: number
    contextSeeds: number
    skippedMessages: number
    /** 文件里出现过但没跟过来的图片张数（图片本体不随 `.tree` 走） */
    images: number
    notes: number
    /** 文件里写了分支来源的节点数（源节点/源消息映射不上时导入端会丢弃） */
    forks: number
  }
}

function normalizeRole(raw: string): 'user' | 'assistant' | null {
  const lower = raw.trim().toLowerCase()
  if (lower === 'user') return 'user'
  if (lower === 'ai' || lower === 'assistant' || lower === 'model' || lower === 'bot') {
    return 'assistant'
  }
  return null
}

/** 只接受有限正数时间戳；字符串、NaN、Infinity、负数一律当不存在。 */
function readTime(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

function readImageCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(Math.trunc(value), 99)
}

/** 画布坐标：两个都必须有限才认 —— 半个坐标会把节点悄悄钉到原点。 */
function readPosition(value: unknown): { x: number; y: number } | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined
  const [x, y] = value
  if (typeof x !== 'number' || typeof y !== 'number') return undefined
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  return { x, y }
}

function readEnrollment(value: unknown): ReviewEnrollment | undefined {
  return value === 'enabled' || value === 'disabled' ? value : undefined
}

function readAssessmentMeta(value: unknown): ParsedAssessmentMeta | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const source: AssessmentSource = raw.source === 'ai' || raw.source === 'review' ? raw.source : 'historical'
  const assessedAt = readTime(raw.assessedAt)
  const basedOnStudiedAt = readTime(raw.basedOnStudiedAt)
  const basedOnPath = typeof raw.basedOnPath === 'string' && raw.basedOnPath ? raw.basedOnPath : undefined
  if (assessedAt === undefined && basedOnStudiedAt === undefined && !basedOnPath) return undefined
  return {
    ...(assessedAt !== undefined ? { assessedAt } : {}),
    ...(basedOnStudiedAt !== undefined ? { basedOnStudiedAt } : {}),
    ...(basedOnPath ? { basedOnPath } : {}),
    source,
  }
}

/**
 * 笔记：锚点必须是「消息内正文纯文本的 `[start, end)`」。
 *
 * 起点不为负、终点不早于起点（与 `normalizeNote` 同一口径）—— 倒置的区间在渲染期会让
 * Range 直接抛错。既没有引用也没有正文的条目等于没有任何落点，丢弃。
 */
function parseNotes(
  rawNotes: NonNullable<z.infer<typeof treeFileSchema>['data']['notes']>,
): ParsedNote[] {
  const notes: ParsedNote[] = []
  for (const raw of rawNotes) {
    const quote = raw.quote?.trim() ?? ''
    const body = raw.body?.trim()
    if (!quote && !body) continue
    const start = Math.max(Math.trunc(raw.start ?? 0), 0)
    const end = Math.max(Math.trunc(raw.end ?? start), start)
    const createdAt = readTime(raw.createdAt) ?? Date.now()
    notes.push({
      ...(raw.id ? { sourceId: raw.id } : {}),
      messageSourceId: raw.messageId,
      kind: isNoteKind(raw.kind) ? raw.kind : 'highlight',
      quote,
      start,
      end,
      ...(body ? { body } : {}),
      createdAt,
      updatedAt: readTime(raw.updatedAt) ?? createdAt,
    })
  }
  return notes
}

function breakCycles(cards: ParsedCard[]): void {
  const parentMap = new Map(cards.map((card) => [card.sourceId, card.parentSourceId]))

  for (const card of cards) {
    const visited = new Set<string>([card.sourceId])
    let cursor = card.parentSourceId

    while (cursor) {
      if (visited.has(cursor)) {
        card.parentSourceId = null
        parentMap.set(card.sourceId, null)
        break
      }
      visited.add(cursor)
      cursor = parentMap.get(cursor) ?? null
    }
  }
}

function orderCardsDfs(cards: ParsedCard[]): ParsedCard[] {
  const byParent = new Map<string | null, ParsedCard[]>()
  for (const card of cards) {
    const list = byParent.get(card.parentSourceId)
    if (list) list.push(card)
    else byParent.set(card.parentSourceId, [card])
  }

  const ordered: ParsedCard[] = []
  const visited = new Set<string>()

  function walk(card: ParsedCard) {
    if (visited.has(card.sourceId)) return
    visited.add(card.sourceId)
    ordered.push(card)
    const children = byParent.get(card.sourceId) ?? []
    for (const child of children) walk(child)
  }

  for (const root of byParent.get(null) ?? []) {
    walk(root)
  }

  for (const card of cards) {
    if (!visited.has(card.sourceId)) ordered.push(card)
  }

  return ordered
}

export function parseTreeJson(rawJson: unknown, fallbackName = '未命名项目'): ParsedProject {
  const parsed = treeFileSchema.safeParse(rawJson)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    const hint = firstIssue
      ? `${firstIssue.path.join('.') || 'root'}: ${firstIssue.message}`
      : '数据结构与预期不符'
    throw new TreeParseError(`不是合法的 .tree 项目文件（${hint}）`)
  }

  const fileData = parsed.data.data
  const rawCards = fileData.cards
  const cardIdSet = new Set(rawCards.map((card) => card.id))

  const parentMap = new Map<string, string>()
  for (const card of rawCards) {
    for (const childId of card.children ?? []) {
      if (cardIdSet.has(childId) && !parentMap.has(childId)) {
        parentMap.set(childId, card.id)
      }
    }
  }

  let skippedMessages = 0
  let totalContextSeeds = 0
  let totalImages = 0

  const cards: ParsedCard[] = rawCards.map((card) => {
    const parentSourceId = parentMap.get(card.id) ?? null
    const messages: ParsedMessage[] = []
    const seedSet = new Set<string>()

    const rawMessages = card.messages ?? []
    rawMessages.forEach((rawMessage, index) => {
      const role = normalizeRole(rawMessage.role)
      const text = typeof rawMessage.content === 'string' ? rawMessage.content.trim() : ''
      const images = readImageCount(rawMessage.images)
      totalImages += images

      // 纯图片消息（v2 会写 images 张数）：正文是空的，落库会变成空气泡，
      // 所以只计入统计如实告知，不建这条消息
      if (!role || !text) {
        skippedMessages += 1
        return
      }

      if (rawMessage.messageType && rawMessage.messageType !== 'text') {
        skippedMessages += 1
        return
      }

      messages.push({
        sourceId: rawMessage.id,
        role,
        content: text,
        createdAt: rawMessage.timestamp ?? (fileData.createdAt ?? Date.now()) + index * 10,
        turnTitle: rawMessage.turnTitle?.trim() || undefined,
        ...(images > 0 ? { images } : {}),
      })

      if (role === 'user' && Array.isArray(rawMessage.context)) {
        for (const item of rawMessage.context) {
          if (typeof item === 'string' && item.trim().length > 0) {
            seedSet.add(item.trim().slice(0, 3000))
          }
        }
      }
    })

    const title =
      card.title?.trim() ||
      messages.find((message) => message.role === 'user')?.content.split('\n')[0]?.slice(0, 42) ||
      '未命名节点'

    if (seedSet.size > 0) totalContextSeeds += 1

    const mastery =
      card.mastery && Number.isFinite(card.mastery.score)
        ? {
            score: Math.min(Math.max(Math.round(card.mastery.score), 0), 100),
            ...(card.mastery.weakPoints && card.mastery.weakPoints.length > 0
              ? { weakPoints: card.mastery.weakPoints.slice(0, 3) }
              : {}),
            // v1 文件没有快照时间：留空交给导入端合成（合成规则只有导入端知道）
            ...(readTime(card.mastery.updatedAt) !== undefined
              ? { updatedAt: readTime(card.mastery.updatedAt) }
              : {}),
            ...(readTime(card.mastery.gradedAt) !== undefined
              ? { gradedAt: readTime(card.mastery.gradedAt) }
              : {}),
          }
        : undefined

    const forkFrom =
      card.forkFrom &&
      typeof card.forkFrom.nodeId === 'string' &&
      typeof card.forkFrom.messageId === 'string'
        ? { nodeSourceId: card.forkFrom.nodeId, messageSourceId: card.forkFrom.messageId }
        : undefined

    const position = readPosition(card.position)
    const reviewEnrollment = readEnrollment(card.reviewEnrollment)
    const assessmentMeta = readAssessmentMeta(card.assessmentMeta)
    const createdAt = readTime(card.createdAt)
    const updatedAt = readTime(card.updatedAt)

    return {
      sourceId: card.id,
      title,
      parentSourceId,
      messages,
      contextSeed: seedSet.size > 0 ? Array.from(seedSet).slice(0, 8) : undefined,
      status: card.archived === true ? 'archived' : 'active',
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(position ? { position } : {}),
      kind: card.kind === 'review' ? 'review' : undefined,
      mastery,
      ...(reviewEnrollment ? { reviewEnrollment } : {}),
      ...(assessmentMeta ? { assessmentMeta } : {}),
      ...(forkFrom ? { forkFrom } : {}),
    }
  })

  breakCycles(cards)
  const orderedCards = orderCardsDfs(cards)
  const roots = orderedCards.filter((card) => card.parentSourceId === null)

  const totalMessages = orderedCards.reduce((sum, card) => sum + card.messages.length, 0)
  const notes = parseNotes(fileData.notes ?? [])

  return {
    name: fileData.name?.trim() || fallbackName,
    createdAt: fileData.createdAt ?? Date.now(),
    updatedAt: fileData.updatedAt ?? Date.now(),
    cards: orderedCards,
    notes,
    stats: {
      cards: orderedCards.length,
      messages: totalMessages,
      roots: roots.length,
      contextSeeds: totalContextSeeds,
      skippedMessages,
      images: totalImages,
      notes: notes.length,
      forks: orderedCards.filter((card) => card.forkFrom).length,
    },
  }
}

export function parseTreeFileText(text: string, fallbackName?: string): ParsedProject {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new TreeParseError(`文件不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  return parseTreeJson(raw, fallbackName)
}