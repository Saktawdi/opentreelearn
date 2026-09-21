import { AppDatabase } from './dexie/db'
import { createDexieRepositories, purgeProject } from './dexie/repos'
import type { Repositories } from './repository'

export type {
  AssetRepository,
  MessageRepository,
  NodeRepository,
  NoteRepository,
  ProjectRepository,
  ProjectSettingsRepository,
  Repositories,
  SettingsRepository,
} from './repository'

let cachedDatabase: AppDatabase | null = null
let cachedRepositories: Repositories | null = null

export function getDatabase(): AppDatabase {
  if (!cachedDatabase) {
    cachedDatabase = new AppDatabase()
  }
  return cachedDatabase
}

export function getRepositories(): Repositories {
  if (!cachedRepositories) {
    cachedRepositories = createDexieRepositories(getDatabase())
  }
  return cachedRepositories
}

export async function deleteProjectData(projectId: string): Promise<void> {
  await purgeProject(getDatabase(), projectId)
}