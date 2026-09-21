import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Asset, Message, Node, Note, Project } from '@/domain/models'
import { AppDatabase } from './dexie/db'
import { createDexieRepositories, purgeProject } from './dexie/repos'

let db: AppDatabase
let repositories: ReturnType<typeof createDexieRepositories>

function makeProject(id: string, updatedAt: number): Project {
  return { id, name: `项目 ${id}`, tags: ['数学'], createdAt: 1, updatedAt }
}

function makeNode(id: string, projectId: string, parentId: string | null): Node {
  return {
    id,
    projectId,
    parentId,
    forkFrom: null,
    title: id,
    position: null,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeMessage(id: string, nodeId: string, projectId: string, createdAt: number): Message {
  return {
    id,
    nodeId,
    projectId,
    role: 'user',
    parts: [{ type: 'text', text: id }],
    createdAt,
  }
}

function makeNote(id: string, messageId: string, nodeId: string): Note {
  return {
    id,
    projectId: 'p1',
    nodeId,
    messageId,
    kind: 'highlight',
    quote: id,
    start: 0,
    end: id.length,
    createdAt: 1,
    updatedAt: 1,
  }
}

beforeEach(() => {
  db = new AppDatabase(`test-${Math.random().toString(36).slice(2)}`)
  repositories = createDexieRepositories(db)
})

describe('project repository', () => {
  it('creates, lists by recency, updates and removes projects', async () => {
    await repositories.projects.create(makeProject('a', 10))
    await repositories.projects.create(makeProject('b', 20))

    const list = await repositories.projects.list()
    expect(list.map((project) => project.id)).toEqual(['b', 'a'])

    await repositories.projects.update('a', { name: '改名', updatedAt: 30 })
    expect((await repositories.projects.get('a'))?.name).toBe('改名')
    expect((await repositories.projects.list()).map((project) => project.id)).toEqual(['a', 'b'])

    await repositories.projects.remove('b')
    expect(await repositories.projects.get('b')).toBeUndefined()
  })

  // 历史记录没有 schema 约束，字段缺失的记录必须在这里被修好，
  // 而不是让 UI 层的 `project.tags.map` 抛异常把整棵树卸载成白屏。
  it('repairs malformed rows on read and never drops them', async () => {
    // 刻意绕过仓储直接写库，模拟旧版本 / 手工导入留下的残缺记录
    await db.projects.put({ id: 'legacy', name: '老项目' } as unknown as Project)

    const list = await repositories.projects.list()
    expect(list.map((project) => project.id)).toEqual(['legacy'])
    expect(list[0].tags).toEqual([])
    expect(list[0].updatedAt).toBe(list[0].createdAt)

    const loaded = await repositories.projects.get('legacy')
    expect(loaded?.tags).toEqual([])
    expect(loaded?.name).toBe('老项目')
  })
})

describe('node and message repositories', () => {
  it('scopes nodes to a project and orders messages by time', async () => {
    await repositories.nodes.create(makeNode('n1', 'p1', null))
    await repositories.nodes.create(makeNode('n2', 'p1', 'n1'))
    await repositories.nodes.create(makeNode('n3', 'p2', null))

    const projectNodes = await repositories.nodes.listByProject('p1')
    expect(projectNodes.map((node) => node.id).sort()).toEqual(['n1', 'n2'])

    await repositories.messages.create(makeMessage('m2', 'n1', 'p1', 200))
    await repositories.messages.create(makeMessage('m1', 'n1', 'p1', 100))

    const messages = await repositories.messages.listByNode('n1')
    expect(messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(await repositories.messages.listByProject('p1')).toHaveLength(2)
  })

  it('stores image assets as blobs', async () => {
    const asset: Asset = {
      id: 'asset-1',
      projectId: 'p1',
      kind: 'image',
      mime: 'image/png',
      createdAt: 1,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    }

    await repositories.assets.create(asset)
    const loaded = await repositories.assets.get('asset-1')
    expect(loaded?.mime).toBe('image/png')
    expect(loaded?.blob.size).toBe(3)
  })
})

describe('settings repository', () => {
  it('falls back to defaults and persists updates', async () => {
    const initial = await repositories.settings.load()
    expect(initial.providers).toEqual([])
    expect(initial.contextBudget).toBeGreaterThan(0)

    await repositories.settings.save({ ...initial, backgroundProfile: '计算机专业' })
    const reloaded = await repositories.settings.load()
    expect(reloaded.backgroundProfile).toBe('计算机专业')
  })
})

describe('note repository', () => {
  it('scopes notes to a project and cleans them up by message, node and project', async () => {
    await repositories.notes.create(makeNote('note-1', 'm1', 'n1'))
    await repositories.notes.create(makeNote('note-2', 'm1', 'n1'))
    await repositories.notes.create(makeNote('note-3', 'm2', 'n2'))

    expect((await repositories.notes.listByProject('p1')).map((note) => note.id).sort()).toEqual([
      'note-1',
      'note-2',
      'note-3',
    ])

    // 消息重试 / 被删：挂在这条消息上的笔记一起走
    await repositories.notes.removeByMessage('m1')
    expect((await repositories.notes.listByProject('p1')).map((note) => note.id)).toEqual([
      'note-3',
    ])

    // 删节点（含子树）：按 nodeId 清
    await repositories.notes.removeByNode('n2')
    expect(await repositories.notes.listByProject('p1')).toEqual([])
  })

  it('repairs malformed anchors on read and drops rows that belong to nothing', async () => {
    // 刻意绕过仓储直接写库，模拟旧版本 / 手工导入留下的残缺记录
    await db.notes.put({
      id: 'broken',
      projectId: 'p1',
      nodeId: 'n1',
      messageId: 'm1',
      kind: '注解',
      quote: 'x',
      start: -5,
      end: -1,
      createdAt: 1,
    } as unknown as Note)
    await db.notes.put({ id: 'orphan', quote: 'x' } as unknown as Note)

    const notes = await repositories.notes.listByProject('p1')
    expect(notes.map((note) => note.id)).toEqual(['broken'])
    expect(notes[0].kind).toBe('highlight')
    expect(notes[0].start).toBe(0)
    expect(notes[0].end).toBe(0)
  })
})

describe('purgeProject', () => {
  it('removes every record belonging to the project', async () => {
    await repositories.projects.create(makeProject('p1', 1))
    await repositories.projectSettings.save({ projectId: 'p1', backgroundProfile: 'x' })
    await repositories.nodes.create(makeNode('n1', 'p1', null))
    await repositories.messages.create(makeMessage('m1', 'n1', 'p1', 1))
    await repositories.notes.create(makeNote('note-1', 'm1', 'n1'))

    await purgeProject(db, 'p1')

    expect(await repositories.projects.get('p1')).toBeUndefined()
    expect(await repositories.projectSettings.get('p1')).toBeUndefined()
    expect(await repositories.nodes.listByProject('p1')).toEqual([])
    expect(await repositories.messages.listByProject('p1')).toEqual([])
    expect(await repositories.notes.listByProject('p1')).toEqual([])
  })
})