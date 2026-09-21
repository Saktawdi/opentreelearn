import type { GlobalSettings, Id, Node, Note, Project } from '@/domain/models'
import {
  normalizeGlobalSettings,
  normalizeNode,
  normalizeNote,
  normalizeProject,
} from '@/domain/normalize'
import type {
  AssetRepository,
  MessageRepository,
  NodeRepository,
  NoteRepository,
  ProjectRepository,
  ProjectSettingsRepository,
  Repositories,
  SettingsRepository,
} from '@/data/repository'
import { createSyncLocal, purgeProjectRows, type SyncLocal } from '../sync-local'
import { SETTINGS_KEY, type AppDatabase } from './db'

function createProjectRepository(db: AppDatabase, sync: SyncLocal): ProjectRepository {
  return {
    // 刻意不用 `orderBy('updatedAt')`：updatedAt 是索引，而 Dexie 在索引键为
    // undefined / 非法类型时会**静默跳过**该记录 —— 一条缺字段的历史数据会从列表里
    // 直接消失。归一化能修复字段，却救不回已经被索引筛掉的记录，所以这里全量读出、
    // 在内存里排序，保证「读回来的记录数 == 库里的记录数」。
    list: async () => {
      const rows = await db.projects.toArray()
      return rows
        .map((row) => normalizeProject(row))
        .filter((project): project is Project => project !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },
    get: async (id) => {
      const row = await db.projects.get(id)
      return row ? (normalizeProject(row) ?? undefined) : undefined
    },
    create: async (project) => {
      await db.projects.put(project)
      await sync.recordChange('project', project.id, 'upsert')
    },
    update: async (id, patch) => {
      await db.projects.update(id, patch)
      await sync.recordChange('project', id, 'upsert')
    },
    remove: async (id) => {
      await db.projects.delete(id)
      await sync.recordChange('project', id, 'delete')
    },
  }
}

function createProjectSettingsRepository(
  db: AppDatabase,
  sync: SyncLocal,
): ProjectSettingsRepository {
  return {
    get: (projectId) => db.projectSettings.get(projectId),
    save: async (settings) => {
      await db.projectSettings.put(settings)
      await sync.recordChange('projectSettings', settings.projectId, 'upsert')
    },
    remove: async (projectId) => {
      await db.projectSettings.delete(projectId)
      await sync.recordChange('projectSettings', projectId, 'delete')
    },
  }
}

/** 节点读出来的兜底归一化：坏字段退化成缺省行为，缺 mastery/review 时上层不用到处判空。 */
function readNodes(rows: unknown[]): Node[] {
  return rows
    .map((row) => normalizeNode(row))
    .filter((node): node is Node => node !== null)
}

function createNodeRepository(db: AppDatabase, sync: SyncLocal): NodeRepository {
  return {
    listByProject: async (projectId) =>
      readNodes(await db.nodes.where('projectId').equals(projectId).toArray()),
    // 首页「今日复习」要看所有项目的到期情况：全量读出在内存里过滤，
    // 与 projects.list 同样的理由 —— 不让索引键缺失的历史数据被静默筛掉
    listAll: async () => readNodes(await db.nodes.toArray()),
    get: async (id) => {
      const row = await db.nodes.get(id)
      return row ? (normalizeNode(row) ?? undefined) : undefined
    },
    create: async (node) => {
      await db.nodes.put(node)
      await sync.recordChange('node', node.id, 'upsert')
    },
    createMany: async (nodes) => {
      if (nodes.length === 0) return
      await db.nodes.bulkPut(nodes)
      for (const node of nodes) await sync.recordChange('node', node.id, 'upsert')
    },
    update: async (id, patch) => {
      await db.nodes.update(id, patch)
      await sync.recordChange('node', id, 'upsert')
    },
    remove: async (id) => {
      await db.nodes.delete(id)
      await sync.recordChange('node', id, 'delete')
    },
    removeByProject: async (projectId) => {
      const removed = await deleteAndCollect(db.nodes.where('projectId').equals(projectId))
      for (const id of removed) await sync.recordChange('node', id, 'delete')
    },
  }
}

function createMessageRepository(db: AppDatabase, sync: SyncLocal): MessageRepository {
  return {
    listByNode: (nodeId) =>
      db.messages.where('nodeId').equals(nodeId).sortBy('createdAt'),
    listByProject: (projectId) => db.messages.where('projectId').equals(projectId).toArray(),
    get: (id) => db.messages.get(id),
    create: async (message) => {
      await db.messages.put(message)
      await sync.recordChange('message', message.id, 'upsert')
    },
    createMany: async (messages) => {
      if (messages.length === 0) return
      await db.messages.bulkPut(messages)
      for (const message of messages) await sync.recordChange('message', message.id, 'upsert')
    },
    update: async (id, patch) => {
      await db.messages.update(id, patch)
      await sync.recordChange('message', id, 'upsert')
    },
    remove: async (id) => {
      await db.messages.delete(id)
      await sync.recordChange('message', id, 'delete')
    },
    removeByProject: async (projectId) => {
      const removed = await deleteAndCollect(db.messages.where('projectId').equals(projectId))
      for (const id of removed) await sync.recordChange('message', id, 'delete')
    },
  }
}

/** 图片资产走对象存储属于 P2，先不进同步台账。 */
function createAssetRepository(db: AppDatabase): AssetRepository {
  return {
    get: (id) => db.assets.get(id),
    listByProject: (projectId) => db.assets.where('projectId').equals(projectId).toArray(),
    create: async (asset) => {
      await db.assets.put(asset)
    },
    remove: async (id) => {
      await db.assets.delete(id)
    },
    removeByProject: async (projectId) => {
      await db.assets.where('projectId').equals(projectId).delete()
    },
  }
}

function createNoteRepository(db: AppDatabase, sync: SyncLocal): NoteRepository {
  return {
    listByProject: async (projectId) => {
      const rows = await db.notes.where('projectId').equals(projectId).toArray()
      return rows
        .map((row) => normalizeNote(row))
        .filter((note): note is Note => note !== null)
    },
    create: async (note) => {
      await db.notes.put(note)
      await sync.recordChange('note', note.id, 'upsert')
    },
    remove: async (id) => {
      await db.notes.delete(id)
      await sync.recordChange('note', id, 'delete')
    },
    removeByNode: async (nodeId) => {
      const removed = await deleteAndCollect(db.notes.where('nodeId').equals(nodeId))
      for (const id of removed) await sync.recordChange('note', id, 'delete')
    },
    removeByMessage: async (messageId) => {
      const removed = await deleteAndCollect(db.notes.where('messageId').equals(messageId))
      for (const id of removed) await sync.recordChange('note', id, 'delete')
    },
    removeByProject: async (projectId) => {
      const removed = await deleteAndCollect(db.notes.where('projectId').equals(projectId))
      for (const id of removed) await sync.recordChange('note', id, 'delete')
    },
  }
}

function createSettingsRepository(db: AppDatabase, sync: SyncLocal): SettingsRepository {
  return {
    load: async () => normalizeGlobalSettings((await db.settings.get(SETTINGS_KEY))?.value),
    save: async (settings: GlobalSettings) => {
      await db.settings.put({ key: SETTINGS_KEY, value: settings })
      await sync.recordChange('globalSettings', SETTINGS_KEY, 'upsert')
    },
  }
}

export function createDexieRepositories(db: AppDatabase): Repositories {
  const sync = createSyncLocal(db)

  return {
    projects: createProjectRepository(db, sync),
    projectSettings: createProjectSettingsRepository(db, sync),
    nodes: createNodeRepository(db, sync),
    messages: createMessageRepository(db, sync),
    assets: createAssetRepository(db),
    notes: createNoteRepository(db, sync),
    settings: createSettingsRepository(db, sync),
  }
}

/**
 * 删除项目及其名下全部记录，并把每一条都记进同步台账。
 * 先把主键收集起来再删 —— 删完就查不到「删掉了哪些」了。
 */
export async function purgeProject(db: AppDatabase, projectId: Id): Promise<void> {
  const project = await db.projects.get(projectId)
  const [nodes, messages, notes] = await Promise.all([
    db.nodes.where('projectId').equals(projectId).primaryKeys(),
    db.messages.where('projectId').equals(projectId).primaryKeys(),
    db.notes.where('projectId').equals(projectId).primaryKeys(),
  ])

  await purgeProjectRows(db, projectId)

  const sync = createSyncLocal(db)
  if (project) await sync.recordChange('project', projectId, 'delete')
  await sync.recordChange('projectSettings', projectId, 'delete')
  for (const id of nodes) await sync.recordChange('node', id, 'delete')
  for (const id of messages) await sync.recordChange('message', id, 'delete')
  for (const id of notes) await sync.recordChange('note', id, 'delete')
}

/**
 * 删除集合里所有记录并返回它们的主键。
 *
 * 不写成泛型：`primaryKeys()` 在 Dexie 里是重载方法，泛型推断会退化成 `unknown`，
 * 调用方拿到的 key 就再也传不进 `recordChange(entity, localId, ...)` 了。
 */
async function deleteAndCollect(collection: {
  primaryKeys(): Promise<Id[]>
  delete(): Promise<number>
}): Promise<Id[]> {
  const keys = await collection.primaryKeys()
  if (keys.length > 0) await collection.delete()
  return keys
}