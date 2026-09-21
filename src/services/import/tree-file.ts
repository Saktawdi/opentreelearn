import { z } from 'zod'

const rawMessageSchema = z.object({
  id: z.string().optional(),
  role: z.string(),
  content: z.union([z.string(), z.null()]).optional(),
  messageType: z.string().optional(),
  timestamp: z.coerce.number().optional(),
  context: z.array(z.string()).optional(),
  turnTitle: z.string().optional(),
})

const rawCardSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  messages: z.array(rawMessageSchema).optional(),
  children: z.array(z.string()).optional(),
  depth: z.coerce.number().optional(),
  // 掌握度与复习中心的导出字段；旧文件没有，缺省即普通节点
  kind: z.string().optional(),
  mastery: z
    .object({
      score: z.coerce.number(),
      weakPoints: z.array(z.string()).optional(),
    })
    .optional(),
})

const treeFileSchema = z.object({
  type: z.literal('project'),
  version: z.coerce.number(),
  data: z.object({
    name: z.string().optional(),
    cards: z.array(rawCardSchema),
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
}

export interface ParsedCard {
  sourceId: string
  title: string
  parentSourceId: string | null
  messages: ParsedMessage[]
  contextSeed?: string[]
  /** 复习中心标记（`.tree` 里有 kind: 'review' 时） */
  kind?: 'review'
  /** 导入时携带的掌握度分数；没有复习排期（那是设备本地状态） */
  mastery?: { score: number; weakPoints?: string[] }
}

export interface ParsedProject {
  name: string
  createdAt: number
  updatedAt: number
  cards: ParsedCard[]
  stats: {
    cards: number
    messages: number
    roots: number
    contextSeeds: number
    skippedMessages: number
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

  const cards: ParsedCard[] = rawCards.map((card) => {
    const parentSourceId = parentMap.get(card.id) ?? null
    const messages: ParsedMessage[] = []
    const seedSet = new Set<string>()

    const rawMessages = card.messages ?? []
    rawMessages.forEach((rawMessage, index) => {
      const role = normalizeRole(rawMessage.role)
      const text = typeof rawMessage.content === 'string' ? rawMessage.content.trim() : ''

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
          }
        : undefined

    return {
      sourceId: card.id,
      title,
      parentSourceId,
      messages,
      contextSeed: seedSet.size > 0 ? Array.from(seedSet).slice(0, 8) : undefined,
      kind: card.kind === 'review' ? 'review' : undefined,
      mastery,
    }
  })

  breakCycles(cards)
  const orderedCards = orderCardsDfs(cards)
  const roots = orderedCards.filter((card) => card.parentSourceId === null)

  const totalMessages = orderedCards.reduce((sum, card) => sum + card.messages.length, 0)

  return {
    name: fileData.name?.trim() || fallbackName,
    createdAt: fileData.createdAt ?? Date.now(),
    updatedAt: fileData.updatedAt ?? Date.now(),
    cards: orderedCards,
    stats: {
      cards: orderedCards.length,
      messages: totalMessages,
      roots: roots.length,
      contextSeeds: totalContextSeeds,
      skippedMessages,
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