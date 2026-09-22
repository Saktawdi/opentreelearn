import type { Id } from '@/domain/models'

const STORAGE_PREFIX = 'otl:last-node:'

function buildKey(projectId: Id): string {
  return `${STORAGE_PREFIX}${projectId}`
}

function read(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(storage: Storage | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // 存储失败（例如隐私模式配额超限或被禁用）静默降级，不阻断主流程
  }
}

function remove(storage: Storage | undefined, key: string): void {
  try {
    storage?.removeItem(key)
  } catch {
    // 静默降级
  }
}

/** 获取某个项目最后打开的节点 ID */
export function getLastOpenedNodeId(
  projectId: Id,
  storage: Storage | undefined = globalThis.localStorage,
): Id | null {
  const value = read(storage, buildKey(projectId))?.trim()
  return value || null
}

/** 记录某个项目最后打开的节点 ID */
export function setLastOpenedNodeId(
  projectId: Id,
  nodeId: Id,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  const trimmed = nodeId.trim()
  if (!trimmed) return
  write(storage, buildKey(projectId), trimmed)
}

/** 清除某个项目最后打开的节点记录 */
export function clearLastOpenedNodeId(
  projectId: Id,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  remove(storage, buildKey(projectId))
}
