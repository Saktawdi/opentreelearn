import { AppDatabase } from './dexie/db'
import { createDexieRepositories, purgeProject } from './dexie/repos'
import { createSyncLocal, type SyncLocal } from './sync-local'
import type { Repositories } from './repository'

export type {
  AssetRepository,
  ComposerDraftRepository,
  GradeReviewInput,
  GradeReviewOutcome,
  MessageRepository,
  NodeRepository,
  NoteRepository,
  ProjectRepository,
  ProjectSettingsRepository,
  Repositories,
  ReviewSessionRepository,
  SettingsRepository,
  UndoReviewInput,
  UndoReviewOutcome,
} from './repository'
export { createSyncLocal, type SyncLocal } from './sync-local'

/** 未登录时用的库名；登录后按账号分库，换账号不会串数据。 */
export const GUEST_DATABASE_NAME = 'opentreelearn'

export function accountDatabaseName(loginName: string): string {
  return `${GUEST_DATABASE_NAME}:${loginName}`
}

let cachedDatabase: AppDatabase | null = null
let cachedRepositories: Repositories | null = null
let cachedSyncLocal: SyncLocal | null = null
let targetName = GUEST_DATABASE_NAME

export function getDatabase(): AppDatabase {
  if (!cachedDatabase) {
    cachedDatabase = new AppDatabase(targetName)
  }
  return cachedDatabase
}

export function getRepositories(): Repositories {
  if (!cachedRepositories) {
    cachedRepositories = createDexieRepositories(getDatabase())
  }
  return cachedRepositories
}

export function getSyncLocal(): SyncLocal {
  if (!cachedSyncLocal) {
    cachedSyncLocal = createSyncLocal(getDatabase())
  }
  return cachedSyncLocal
}

export function currentDatabaseName(): string {
  return getDatabase().name
}

/**
 * 切换到某个库（登录换账号、退出登录回游客库）。
 *
 * 只负责换库并丢弃缓存；**调用方必须在返回 true 后重载各 store** ——
 * 内存里此刻还留着上一个账号的项目、节点与设置。
 * 返回 false 表示本来就在这个库上，什么都不用做。
 */
export async function switchDatabase(name: string): Promise<boolean> {
  const normalized = name || GUEST_DATABASE_NAME
  if (getDatabase().name === normalized) return false

  cachedDatabase?.close()
  cachedDatabase = null
  cachedRepositories = null
  cachedSyncLocal = null
  targetName = normalized
  // 立刻打开新库，让「切库失败」在调用处就暴露，而不是等到下一次查询
  getDatabase()
  return true
}

export async function deleteProjectData(projectId: string): Promise<void> {
  await purgeProject(getDatabase(), projectId)
}

/** 打开另一个库而不切换当前库（首次登录搬运游客数据时用）。用完记得 close。 */
export function openDatabase(name: string): AppDatabase {
  return new AppDatabase(name)
}