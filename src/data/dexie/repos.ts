import type { GlobalSettings, Id, Project } from '@/domain/models'
import { normalizeGlobalSettings, normalizeProject } from '@/domain/normalize'
import type {
  AssetRepository,
  MessageRepository,
  NodeRepository,
  ProjectRepository,
  ProjectSettingsRepository,
  Repositories,
  SettingsRepository,
} from '@/data/repository'
import { SETTINGS_KEY, type AppDatabase } from './db'

function createProjectRepository(db: AppDatabase): ProjectRepository {
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
    },
    update: async (id, patch) => {
      await db.projects.update(id, patch)
    },
    remove: async (id) => {
      await db.projects.delete(id)
    },
  }
}

function createProjectSettingsRepository(db: AppDatabase): ProjectSettingsRepository {
  return {
    get: (projectId) => db.projectSettings.get(projectId),
    save: async (settings) => {
      await db.projectSettings.put(settings)
    },
    remove: async (projectId) => {
      await db.projectSettings.delete(projectId)
    },
  }
}

function createNodeRepository(db: AppDatabase): NodeRepository {
  return {
    listByProject: (projectId) => db.nodes.where('projectId').equals(projectId).toArray(),
    get: (id) => db.nodes.get(id),
    create: async (node) => {
      await db.nodes.put(node)
    },
    createMany: async (nodes) => {
      if (nodes.length === 0) return
      await db.nodes.bulkPut(nodes)
    },
    update: async (id, patch) => {
      await db.nodes.update(id, patch)
    },
    remove: async (id) => {
      await db.nodes.delete(id)
    },
    removeByProject: async (projectId) => {
      await db.nodes.where('projectId').equals(projectId).delete()
    },
  }
}

function createMessageRepository(db: AppDatabase): MessageRepository {
  return {
    listByNode: (nodeId) =>
      db.messages.where('nodeId').equals(nodeId).sortBy('createdAt'),
    listByProject: (projectId) => db.messages.where('projectId').equals(projectId).toArray(),
    get: (id) => db.messages.get(id),
    create: async (message) => {
      await db.messages.put(message)
    },
    createMany: async (messages) => {
      if (messages.length === 0) return
      await db.messages.bulkPut(messages)
    },
    update: async (id, patch) => {
      await db.messages.update(id, patch)
    },
    remove: async (id) => {
      await db.messages.delete(id)
    },
    removeByProject: async (projectId) => {
      await db.messages.where('projectId').equals(projectId).delete()
    },
  }
}

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

function createSettingsRepository(db: AppDatabase): SettingsRepository {
  return {
    load: async () => normalizeGlobalSettings((await db.settings.get(SETTINGS_KEY))?.value),
    save: async (settings: GlobalSettings) => {
      await db.settings.put({ key: SETTINGS_KEY, value: settings })
    },
  }
}

export function createDexieRepositories(db: AppDatabase): Repositories {
  return {
    projects: createProjectRepository(db),
    projectSettings: createProjectSettingsRepository(db),
    nodes: createNodeRepository(db),
    messages: createMessageRepository(db),
    assets: createAssetRepository(db),
    settings: createSettingsRepository(db),
  }
}

export async function purgeProject(db: AppDatabase, projectId: Id): Promise<void> {
  await db.transaction('rw', db.projects, db.projectSettings, db.nodes, db.messages, db.assets, async () => {
    await db.projects.delete(projectId)
    await db.projectSettings.delete(projectId)
    await db.nodes.where('projectId').equals(projectId).delete()
    await db.messages.where('projectId').equals(projectId).delete()
    await db.assets.where('projectId').equals(projectId).delete()
  })
}