import i18n from '@/i18n'
import { getDatabase, getRepositories } from '@/data'
import type { Message, Node, Note, Project } from '@/domain/models'
import { newId } from '@/lib/id'
import { parseTreeFileText, type ParsedCard, type ParsedNote, type ParsedProject } from './tree-file'

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

/**
 * 文件里最早的一条消息时间 —— 老文件（v1 / 外部工具）没有卡片自己的时间戳时的降级依据。
 *
 * 节点总是「先有节点、后有对话」，所以首条消息时间只比真实创建时间晚一点；
 * 用来还原节点之间的先后顺序足够了。
 */
function earliestMessageAt(card: ParsedCard): number | undefined {
  let earliest: number | undefined
  for (const message of card.messages) {
    if (earliest === undefined || message.createdAt < earliest) earliest = message.createdAt
  }
  return earliest
}

export async function importParsedProject(parsed: ParsedProject): Promise<ImportResult> {
  const db = getDatabase()
  const repositories = getRepositories()
  const now = Date.now()

  const project: Project = {
    id: newId(),
    name: parsed.name,
    tags: [i18n.t('common:import.tag')],
    createdAt: parsed.createdAt || now,
    updatedAt: parsed.updatedAt || now,
  }

  const nodeIdMap = new Map<string, string>()
  for (const card of parsed.cards) {
    nodeIdMap.set(card.sourceId, newId())
  }

  // 消息 id 也要重编号，但分支来源（forkFrom）锚在具体某条消息上：
  // 先按文件里的 id 建映射，节点与笔记都用它换算，引用才不会是悬空的旧 id。
  const messageIdMap = new Map<string, string>()
  const messageNodeMap = new Map<string, string>()
  for (const card of parsed.cards) {
    const nodeId = nodeIdMap.get(card.sourceId)!
    for (const msg of card.messages) {
      if (!msg.sourceId || messageIdMap.has(msg.sourceId)) continue
      const messageId = newId()
      messageIdMap.set(msg.sourceId, messageId)
      messageNodeMap.set(messageId, nodeId)
    }
  }

  const baseOrderTime = project.createdAt
  const nodes: Node[] = parsed.cards.map((card, index) => {
    // **时间就是位置**：画布的树布局按 createdAt 排列根节点与同级节点。若按数组下标合成时间，
    // 导入后的左右次序与文件里的次序就不一定一致 —— 节点一个没少，却在画布上换了地方，
    // 用户会当成「整棵树不见了」。所以：文件带的真实时间 > 最早一条消息的时间 > 数组顺序兜底。
    const createdAt = card.createdAt ?? earliestMessageAt(card) ?? baseOrderTime + index
    const updatedAt = card.updatedAt ?? createdAt
    const masteryAt = createdAt
    const lastStudiedAt = importedLastStudiedAt(card, masteryAt)
    const forkFrom = resolveFork(card, nodeIdMap, messageIdMap)
    return {
      id: nodeIdMap.get(card.sourceId)!,
      projectId: project.id,
      parentId: card.parentSourceId ? nodeIdMap.get(card.parentSourceId) ?? null : null,
      forkFrom,
      title: card.title,
      contextSeed: card.contextSeed,
      position: card.position ?? null,
      status: card.status,
      ...(card.kind === 'review' ? { kind: 'review' as const } : {}),
      // 掌握度：分数与薄弱点是「参考数据」，快照时间用文件里的真实时间（v1 文件没有，
      // 退回按顺序合成的时间）。计划开关按文件显式值恢复；缺省（v1 / 外部文件）一律
      // 未加入 —— 「加入复习计划」是显式动作，导入不替用户打开，也不初始化卡片，
      // 免得刚导入就堆出一批虚假逾期。
      ...(card.mastery
        ? {
            mastery: {
              score: card.mastery.score,
              weakPoints: card.mastery.weakPoints,
              updatedAt: card.mastery.updatedAt ?? masteryAt,
              ...(card.mastery.gradedAt !== undefined ? { gradedAt: card.mastery.gradedAt } : {}),
            },
            reviewEnrollment: card.reviewEnrollment ?? ('disabled' as const),
            assessmentMeta: card.assessmentMeta ?? {
              assessedAt: masteryAt,
              basedOnStudiedAt: lastStudiedAt,
              source: 'historical' as const,
            },
          }
        : {}),
      ...(lastStudiedAt === undefined ? {} : { lastStudiedAt }),
      createdAt,
      updatedAt,
    }
  })

  const messages: Message[] = []
  for (const card of parsed.cards) {
    const nodeId = nodeIdMap.get(card.sourceId)!
    for (const msg of card.messages) {
      const messageId = msg.sourceId ? messageIdMap.get(msg.sourceId) : undefined
      messages.push({
        id: messageId ?? newId(),
        nodeId,
        projectId: project.id,
        role: msg.role,
        parts: [{ type: 'text', text: msg.content }],
        createdAt: msg.createdAt,
        updatedAt: msg.createdAt,
      })
    }
  }

  const notes = importNotes(parsed.notes, project.id, messageIdMap, messageNodeMap)

  // outbox 必须在事务里：仓储的每次写入都要记同步台账，漏了这张表
  // Dexie 会直接抛 SubTransactionError，整次导入回滚。
  await db.transaction(
    'rw',
    db.projects,
    db.nodes,
    db.messages,
    db.notes,
    db.outbox,
    async () => {
      await repositories.projects.create(project)
      await repositories.nodes.createMany(nodes)
      await repositories.messages.createMany(messages)
      for (const note of notes) await repositories.notes.create(note)
    },
  )

  return { project, stats: parsed.stats }
}

/**
 * 还原分支来源：源节点与源消息都映射得上才认。
 *
 * 冻结的版号快照 `selection` 不还原 —— 它指向的是源节点版本槽里的消息 id，而版本链
 * 本身不随 `.tree` 走（只导出显示路径），拿旧 id 硬套只会指向别的消息。缺省情况下
 * 解析会回退到源节点当前选择的最新版，这是 `.tree` 的既有语义。
 */
function resolveFork(
  card: ParsedCard,
  nodeIdMap: Map<string, string>,
  messageIdMap: Map<string, string>,
): Node['forkFrom'] {
  if (!card.forkFrom) return null
  const nodeId = nodeIdMap.get(card.forkFrom.nodeSourceId)
  const messageId = messageIdMap.get(card.forkFrom.messageSourceId)
  if (!nodeId || !messageId) return null
  return { nodeId, messageId }
}

/** 标注：锚点跟着消息 id 一起重映射，映射不上就丢弃（不留下悬空标注）。 */
function importNotes(
  parsedNotes: ParsedNote[],
  projectId: string,
  messageIdMap: Map<string, string>,
  messageNodeMap: Map<string, string>,
): Note[] {
  const notes: Note[] = []
  for (const note of parsedNotes) {
    const messageId = messageIdMap.get(note.messageSourceId)
    const nodeId = messageId ? messageNodeMap.get(messageId) : undefined
    if (!messageId || !nodeId) continue
    notes.push({
      id: newId(),
      projectId,
      nodeId,
      messageId,
      labels: note.labels,
      quote: note.quote,
      start: note.start,
      end: note.end,
      ...(note.body ? { body: note.body } : {}),
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    })
  }
  return notes
}

export async function importTreeFile(file: File): Promise<ImportResult> {
  const text = await file.text()
  const fallback = file.name.replace(/\.(tree|json)$/i, '') || i18n.t('common:import.importedProject')
  const parsed = parseTreeFileText(text, fallback)
  return importParsedProject(parsed)
}