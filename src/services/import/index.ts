import { getDatabase, getRepositories } from '@/data'
import type { Message, Node, Project } from '@/domain/models'
import { newId } from '@/lib/id'
import { parseTreeFileText, type ParsedProject } from './tree-file'

export interface ImportResult {
  project: Project
  stats: ParsedProject['stats']
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
  const nodes: Node[] = parsed.cards.map((card, index) => ({
    id: idMap.get(card.sourceId)!,
    projectId: project.id,
    parentId: card.parentSourceId ? idMap.get(card.parentSourceId) ?? null : null,
    forkFrom: null,
    title: card.title,
    contextSeed: card.contextSeed,
    position: null,
    status: 'active',
    createdAt: baseOrderTime + index,
    updatedAt: baseOrderTime + index,
  }))

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

  await db.transaction('rw', db.projects, db.nodes, db.messages, async () => {
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