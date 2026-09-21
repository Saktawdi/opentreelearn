import type {
  Id,
  Message,
  Node,
  NodeThread,
  ThreadSlot,
  ThreadVersion,
} from '@/domain/models'

/**
 * 一条消息上挂了版本信息 —— 说明「从这条消息起」的后半程有过若干版，
 * 当前显示的是其中一版。UI 据此把 `< 2/3 >` 横线画在这条气泡下面。
 */
export interface ResolvedVersion {
  slotId: Id
  /** 选中版在 `slot.versions` 里的下标（0 起） */
  index: number
  total: number
}

export interface ResolvedThread {
  /** 显示路径（有序）；喂模型、卡片摘要、导出都只认它 */
  path: Message[]
  /** 键 = 当前选中版的第一条消息 id；只有多版（total > 1）的槽才会登记 */
  versions: Map<Id, ResolvedVersion>
}

export interface SlotVersionSummary {
  version: number
  index: number
  /** 该版展开后的第一条消息；空版或悬空时为 null */
  messageId: Id | null
}

/** 只接受结构像样的 thread；坏数据一律当作「没有版本」退化处理，绝不抛异常。 */
export function readThread(node: Node): NodeThread | null {
  const thread = node.thread
  if (!thread || typeof thread !== 'object') return null
  if (!Array.isArray(thread.entries)) return null
  if (!thread.slots || typeof thread.slots !== 'object') return null
  if (thread.selection !== undefined && (typeof thread.selection !== 'object' || thread.selection === null)) {
    return null
  }
  return thread
}

export function isSlotEntry(entry: unknown): entry is { slot: Id } {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as { slot?: unknown }).slot === 'string'
  )
}

function versionEntries(version: ThreadVersion | undefined): unknown {
  return version && Array.isArray(version.entries) ? version.entries : []
}

/** 选中版：显式版号不存在（缺省/被淘汰/坏数据）时回退到最新版。 */
export function findVersion(
  slot: ThreadSlot | undefined,
  versionNumber?: number,
): { version: ThreadVersion; index: number } | null {
  if (!slot || !Array.isArray(slot.versions) || slot.versions.length === 0) return null
  if (typeof versionNumber === 'number') {
    const index = slot.versions.findIndex((version) => version.version === versionNumber)
    if (index >= 0) return { version: slot.versions[index], index }
  }
  let best = 0
  for (let i = 1; i < slot.versions.length; i += 1) {
    if (slot.versions[i].version > slot.versions[best].version) best = i
  }
  return { version: slot.versions[best], index: best }
}

export function latestVersionNumber(slot: ThreadSlot | undefined): number | null {
  if (!slot || !Array.isArray(slot.versions) || slot.versions.length === 0) return null
  return slot.versions.reduce(
    (max, version) => (version.version > max ? version.version : max),
    slot.versions[0].version,
  )
}

/**
 * 解析节点内的显示路径。
 *
 * - `thread` 缺省或坏数据 ⇒ 退化为按 `createdAt` 的线性路径（老数据、导入的 .tree）
 * - 递归展开 `entries`：遇到 `{ slot }` 换成「选中版（缺省最新版）」的 entries；
 *   跳过解析不到的悬空 id；循环引用直接截断
 * - `versions` 键 = 当前选中版的第一条消息 id，编辑版落在用户消息上、
 *   重新生成版落在回答上
 *
 * `selection` 用于 fork 子节点：冻结源节点 fork 时的版本选择，优先级高于源节点当前选择。
 */
export function resolveThread(
  node: Node,
  messages: Message[],
  selection?: Record<Id, number>,
): ResolvedThread {
  const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt)
  const thread = readThread(node)
  if (!thread) return { path: sorted, versions: new Map() }

  const byId = new Map(sorted.map((message) => [message.id, message]))
  const path: Message[] = []
  const versions = new Map<Id, ResolvedVersion>()
  const effective = selection ?? thread.selection
  const visited = new Set<Id>()

  const expand = (entries: unknown): void => {
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (typeof entry === 'string') {
        const message = byId.get(entry)
        if (message) path.push(message)
        continue
      }
      if (!isSlotEntry(entry)) continue
      if (visited.has(entry.slot)) continue
      const slot = thread.slots[entry.slot] as ThreadSlot | undefined
      const chosen = findVersion(slot, effective?.[entry.slot])
      if (!chosen || !slot) continue
      visited.add(entry.slot)
      const start = path.length
      expand(versionEntries(chosen.version))
      const first = path[start]
      // 只有一版的槽没有可切换的对象，不产生版本横线信息（正常数据不会出现，防导入/坏数据）
      if (slot.versions.length > 1) {
        if (first) {
          versions.set(first.id, {
            slotId: entry.slot,
            index: chosen.index,
            total: slot.versions.length,
          })
        } else {
          // 选中的版一条消息都解析不出来（重新生成刚失败、回答还没落库的那一版）：
          // 挂到槽标记前的那条消息上，用户仍能一键切回旧版；已有版本横线的那条不抢
          const anchor = path[start - 1]
          if (anchor && !versions.has(anchor.id)) {
            versions.set(anchor.id, {
              slotId: entry.slot,
              index: chosen.index,
              total: slot.versions.length,
            })
          }
        }
      }
    }
  }

  expand(thread.entries)
  // 有消息却一条都没解析出来 ⇒ 数据已经坏到不能信，退回线性，至少不把对话吞掉
  if (path.length === 0 && sorted.length > 0) return { path: sorted, versions: new Map() }
  return { path, versions }
}

/** 每个版本展开后的第一条消息，供版本横线 hover 时说明「这一版从这里开始」。 */
export function summarizeSlotVersions(
  node: Node,
  messages: Message[],
  slotId: Id,
): SlotVersionSummary[] {
  const thread = readThread(node)
  const slot = thread?.slots?.[slotId]
  if (!thread || !slot || !Array.isArray(slot.versions)) return []

  const byId = new Set(messages.map((message) => message.id))
  const summaries: SlotVersionSummary[] = []

  for (const [index, version] of slot.versions.entries()) {
    const visited = new Set<Id>()
    let first: Id | null = null
    const walk = (entries: unknown): void => {
      if (first || !Array.isArray(entries)) return
      for (const entry of entries) {
        if (typeof entry === 'string') {
          if (byId.has(entry)) {
            first = entry
            return
          }
          continue
        }
        if (!isSlotEntry(entry) || visited.has(entry.slot)) continue
        const nested = thread.slots[entry.slot] as ThreadSlot | undefined
        const chosen = findVersion(nested, thread.selection?.[entry.slot])
        if (!nested || !chosen) continue
        visited.add(entry.slot)
        walk(versionEntries(chosen.version))
        if (first) return
      }
    }
    walk(versionEntries(version))
    summaries.push({ version: version.version, index, messageId: first })
  }

  return summaries
}

/** fork 冻结的版号已被淘汰（或槽已不存在）的槽 id；用于继承提示条上说明回退。 */
export function staleSelectionSlots(node: Node, selection?: Record<Id, number>): Id[] {
  if (!selection) return []
  const thread = readThread(node)
  if (!thread) return Object.keys(selection)
  return Object.entries(selection)
    .filter(([slotId, version]) => {
      const slot = thread.slots[slotId] as ThreadSlot | undefined
      return !slot || !Array.isArray(slot.versions) || !slot.versions.some((item) => item.version === version)
    })
    .map(([slotId]) => slotId)
}

