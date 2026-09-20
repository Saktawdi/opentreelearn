import { createDefaultSettings } from '@/domain/defaults'
import type { GlobalSettings, Id } from '@/domain/models'
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
    list: () => db.projects.orderBy('updatedAt').reverse().toArray(),
    get: (id) => db.projects.get(id),
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
    load: async () => {
      const record = await db.settings.get(SETTINGS_KEY)
      return record
        ? { ...createDefaultSettings(), ...record.value }
        : createDefaultSettings()
    },
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