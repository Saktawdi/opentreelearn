import { getDatabase, getRepositories } from '@/data'
import type { Message, Node, Project } from '@/domain/models'
import { seedReviewCard } from '@/domain/review/schedule'
import { newId } from '@/lib/id'
import { parseTreeFileText, type ParsedCard, type ParsedProject } from './tree-file'

export interface ImportResult {
  project: Project
  stats: ParsedProject['stats']
}

/**
 * 导入卡片的「最后学习时间」。
 *
 * 口径与应用内一致：显示路径末条消息的 `createdAt`（`.tree` 只导出显示路径）。
 * 刻意不按数组顺序取最后一条 —— 外部工具生成的 `.tree` 不保证消息有序。
 *
 * 没有对话、只剩掌握度的卡片（对话在导出前被裁掉）退回掌握度快照时间：
 * 否则它会显示成「尚未学习」，复习中心的 digest 与掌握度过期标记都会读错。
 */
function importedLastStudiedAt(card: ParsedCard, masteryAt: number): number | undefined {
  let latest: number | undefined
  for (const message of card.messages) {
    if (latest === undefined || message.createdAt > latest) latest = message.createdAt
  }
  if (latest !== undefined) return latest
  return card.mastery ? masteryAt : undefined
}

export async function importParsedProject(parsed: ParsedProject): Promise<ImportResult> {
  const db = getDatabase()
  const repositories = getRepositories()
  const now = Date.now()

  const project: Project = {
    id: newId(),
    name: parsed.name,
    tags: ['导入'],
    createdAt: parsed.createdAt || now,
    updatedAt: parsed.updatedAt || now,
  }

  const idMap = new Map<string, string>()
  for (const card of parsed.cards) {
    idMap.set(card.sourceId, newId())
  }

  const baseOrderTime = project.createdAt
  const nodes: Node[] = parsed.cards.map((card, index) => {
    const masteryAt = baseOrderTime + index
    const lastStudiedAt = importedLastStudiedAt(card, masteryAt)
    return {
      id: idMap.get(card.sourceId)!,
      projectId: project.id,
      parentId: card.parentSourceId ? idMap.get(card.parentSourceId) ?? null : null,
      forkFrom: null,
      title: card.title,
      contextSeed: card.contextSeed,
      position: null,
      status: 'active',
      ...(card.kind === 'review' ? { kind: 'review' as const } : {}),
      // 导入的掌握度按档位种一张卡（导入时刻起排期），跟应用内首次评估一致；
      // .tree 不携带复习排期本身
      ...(card.mastery
        ? {
            mastery: {
              score: card.mastery.score,
              weakPoints: card.mastery.weakPoints,
              updatedAt: masteryAt,
            },
            review: seedReviewCard(card.mastery.score, masteryAt),
          }
        : {}),
      ...(lastStudiedAt === undefined ? {} : { lastStudiedAt }),
      createdAt: masteryAt,
      updatedAt: masteryAt,
    }
  })

  const messages: Message[] = []
  for (const card of parsed.cards) {
    const nodeId = idMap.get(card.sourceId)!
    for (const msg of card.messages) {
      messages.push({
        id: newId(),
        nodeId,
        projectId: project.id,
        role: msg.role,
        parts: [{ type: 'text', text: msg.content }],
        createdAt: msg.createdAt,
        updatedAt: msg.createdAt,
      })
    }
  }

  // outbox 必须在事务里：仓储的每次写入都要记同步台账，漏了这张表
  // Dexie 会直接抛 SubTransactionError，整次导入回滚。
  await db.transaction('rw', db.projects, db.nodes, db.messages, db.outbox, async () => {
    await repositories.projects.create(project)
    await repositories.nodes.createMany(nodes)
    await repositories.messages.createMany(messages)
  })

  return { project, stats: parsed.stats }
}

export async function importTreeFile(file: File): Promise<ImportResult> {
  const text = await file.text()
  const fallback = file.name.replace(/\.(tree|json)$/i, '') || '导入项目'
  const parsed = parseTreeFileText(text, fallback)
  return importParsedProject(parsed)
}