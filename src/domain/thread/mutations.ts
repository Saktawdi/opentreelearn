import type { Id, Message, Node, NodeThread, ThreadEntry, ThreadSlot, ThreadVersion } from '@/domain/models'
import { findVersion, isSlotEntry, latestVersionNumber, readThread } from './resolve'

/** 每个版本槽最多保留的版本数；超出的淘汰「除新版本外最早的一版」并级联清理。 */
export const MAX_THREAD_VERSIONS = 3

export interface ThreadChange {
  thread: NodeThread
  /** 被淘汰版本（含嵌套槽）里所有可达消息 id —— 调用方负责删消息与笔记 */
  removedMessageIds: Id[]
  /** 随淘汰版本一起摘掉的嵌套槽 id */
  removedSlotIds: Id[]
}

interface EntryLocation {
  entries: ThreadEntry[]
  index: number
  /** 目标位于某个版本槽的 entries 里时的槽 id；顶层 entries 为 undefined */
  ownerSlotId?: Id
}

function cloneEntry(entry: ThreadEntry): ThreadEntry {
  return typeof entry === 'string' ? entry : { slot: entry.slot }
}

/** 纯函数只在副本上改，调用方（store）拿返回值覆盖 node.thread。 */
function cloneThread(thread: NodeThread): NodeThread {
  const next: NodeThread = { entries: thread.entries.map(cloneEntry), slots: {} }
  if (thread.selection) next.selection = { ...thread.selection }
  for (const [slotId, slot] of Object.entries(thread.slots ?? {})) {
    next.slots[slotId] = {
      versions: (slot?.versions ?? []).map((version) => ({
        version: version.version,
        entries: Array.isArray(version.entries) ? version.entries.map(cloneEntry) : [],
      })),
    }
  }
  return next
}

function maxVersionNumber(thread: NodeThread): number {
  let max = 0
  for (const slot of Object.values(thread.slots ?? {})) {
    for (const version of slot?.versions ?? []) {
      if (version.version > max) max = version.version
    }
  }
  return max
}

/**
 * 下一个版号 = 全树已知最大版号 + 1；新建槽的 v1 恒为 1，
 * 所以下限从 1 起算，避免新建槽里 v1 与新版本撞号。
 */
function nextVersionNumber(thread: NodeThread): number {
  return Math.max(maxVersionNumber(thread), 1) + 1
}

/**
 * 惰性建 thread：首次编辑时把节点里现存消息按时间排成顶层 entries。
 * 已有结构就直接克隆一份；坏数据当作没有，重建。
 */
export function ensureThread(node: Node, messages: Message[]): NodeThread {
  const existing = readThread(node)
  if (existing) return cloneThread(existing)
  return {
    entries: [...messages]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((message) => message.id),
    slots: {},
  }
}

/** 在整棵版本树里找某个消息 id 直接落在哪个 entries 数组里。 */
function locateEntry(thread: NodeThread, messageId: Id): EntryLocation | null {
  const top = thread.entries.findIndex((entry) => entry === messageId)
  if (top >= 0) return { entries: thread.entries, index: top }

  for (const [slotId, slot] of Object.entries(thread.slots ?? {})) {
    for (const version of slot?.versions ?? []) {
      if (!Array.isArray(version.entries)) continue
      const index = version.entries.findIndex((entry) => entry === messageId)
      if (index >= 0) return { entries: version.entries, index, ownerSlotId: slotId }
    }
  }
  return null
}

interface Collected {
  messageIds: Set<Id>
  slotIds: Set<Id>
}

/** 递归展开一段 entries：收集所有消息 id，以及沿途遇到的嵌套槽 id。 */
function collectEntries(
  thread: NodeThread,
  entries: unknown,
  collected: Collected,
  visited: Set<Id>,
): void {
  if (!Array.isArray(entries)) return
  for (const entry of entries) {
    if (typeof entry === 'string') {
      collected.messageIds.add(entry)
      continue
    }
    if (!isSlotEntry(entry) || visited.has(entry.slot)) continue
    const slot = thread.slots?.[entry.slot] as ThreadSlot | undefined
    if (!slot) continue
    visited.add(entry.slot)
    collected.slotIds.add(entry.slot)
    for (const version of slot.versions ?? []) {
      collectEntries(thread, version.entries, collected, visited)
    }
  }
}

/** 某个版本槽（含全部版本与嵌套槽）可达的消息 id；用于淘汰时级联清理。 */
export function collectSlotMessages(thread: NodeThread, slotId: Id): Id[] {
  const slot = thread.slots?.[slotId]
  if (!slot) return []
  const collected: Collected = { messageIds: new Set(), slotIds: new Set() }
  const visited = new Set<Id>([slotId])
  for (const version of slot.versions ?? []) {
    collectEntries(thread, version.entries, collected, visited)
  }
  return [...collected.messageIds]
}

/**
 * 版本数超限时淘汰「除新版本外最早的一版」：
 * 递归收集它（含嵌套槽全部版本）可达的消息与嵌套槽，摘掉嵌套槽；
 * 若它正好是当前选中版，改选最新版。
 */
function pruneSlotOverflow(
  thread: NodeThread,
  slotId: Id,
  keepVersion: number,
  removed: { messageIds: Set<Id>; slotIds: Set<Id> },
): void {
  const slot = thread.slots?.[slotId]
  if (!slot || !Array.isArray(slot.versions)) return

  while (slot.versions.length > MAX_THREAD_VERSIONS) {
    let victimIndex = -1
    for (let i = 0; i < slot.versions.length; i += 1) {
      const version = slot.versions[i]
      if (version.version === keepVersion) continue
      if (victimIndex < 0 || version.version < slot.versions[victimIndex].version) victimIndex = i
    }
    if (victimIndex < 0) break

    const [victim] = slot.versions.splice(victimIndex, 1)
    const collected: Collected = { messageIds: new Set(), slotIds: new Set() }
    collectEntries(thread, victim.entries, collected, new Set())

    for (const messageId of collected.messageIds) removed.messageIds.add(messageId)
    for (const nestedSlotId of collected.slotIds) {
      removed.slotIds.add(nestedSlotId)
      delete thread.slots[nestedSlotId]
      if (thread.selection) delete thread.selection[nestedSlotId]
    }

    if (thread.selection?.[slotId] === victim.version) {
      const latest = latestVersionNumber(slot)
      if (latest !== null) thread.selection[slotId] = latest
    }
  }
}

function change(
  thread: NodeThread,
  removedMessageIds: Set<Id>,
  removedSlotIds: Set<Id>,
): ThreadChange {
  return {
    thread,
    removedMessageIds: [...removedMessageIds],
    removedSlotIds: [...removedSlotIds],
  }
}

function pushVersion(slot: ThreadSlot, version: ThreadVersion): void {
  slot.versions.push(version)
}

/**
 * 编辑用户消息：从这条提问处整段换一版。
 *
 * - 首次编辑惰性建 thread
 * - 一般情形：在它所在的 entries 里，把它及其后的项整体搬进 v1，
 *   父列表变成 `entries[0..i-1] + [{ slot: slotId }]`，新版本存新提问与新回答
 * - 它正好是某一版的第一条消息（含「切到旧版后又编辑同一条提问」）⇒ 并进同一版本槽，
 *   不嵌套：否则内外两层槽会抢同一条版本横线，外层历史将无法切回
 */
export function createEditVersion(input: {
  node: Node
  messages: Message[]
  messageId: Id
  newUserMessageId: Id
  newAnswerMessageId: Id
}): ThreadChange | null {
  const thread = ensureThread(input.node, input.messages)
  const located = locateEntry(thread, input.messageId)
  if (!located) return null

  const newVersion = nextVersionNumber(thread)
  const removedMessages = new Set<Id>()
  const removedSlots = new Set<Id>()
  const selection = thread.selection ?? (thread.selection = {})

  const ownerSlot = located.ownerSlotId ? thread.slots[located.ownerSlotId] : undefined
  if (located.index === 0 && ownerSlot) {
    pushVersion(ownerSlot, {
      version: newVersion,
      entries: [input.newUserMessageId, input.newAnswerMessageId],
    })
    selection[located.ownerSlotId!] = newVersion
    pruneSlotOverflow(thread, located.ownerSlotId!, newVersion, {
      messageIds: removedMessages,
      slotIds: removedSlots,
    })
    return change(thread, removedMessages, removedSlots)
  }

  const moved = located.entries.splice(located.index)
  located.entries.push({ slot: input.messageId })
  // 有效数据里 anchor 不会被占用（锚点永远落在某一版的第一条，走上面的并槽分支）；
  // 真被占用了也只覆盖这一槽，不抛异常。
  thread.slots[input.messageId] = {
    versions: [
      { version: 1, entries: moved },
      { version: newVersion, entries: [input.newUserMessageId, input.newAnswerMessageId] },
    ],
  }
  selection[input.messageId] = newVersion
  return change(thread, removedMessages, removedSlots)
}

/**
 * 重新生成回答：标记留在提问之后，旧回答成为 v1、新回答是 v2 ——
 * 共享的提问不进任何版本，两个版本只差答案。
 *
 * 回答正好是某一版的第一条消息（连续重新生成）时并进同一版本槽，与编辑同理。
 */
export function openAnswerVersion(input: {
  node: Node
  messages: Message[]
  messageId: Id
  newAnswerMessageId: Id
}): ThreadChange | null {
  const thread = ensureThread(input.node, input.messages)
  const located = locateEntry(thread, input.messageId)
  if (!located) return null

  const newVersion = nextVersionNumber(thread)
  const removedMessages = new Set<Id>()
  const removedSlots = new Set<Id>()
  const selection = thread.selection ?? (thread.selection = {})

  const ownerSlot = located.ownerSlotId ? thread.slots[located.ownerSlotId] : undefined
  if (located.index === 0 && ownerSlot) {
    pushVersion(ownerSlot, { version: newVersion, entries: [input.newAnswerMessageId] })
    selection[located.ownerSlotId!] = newVersion
    pruneSlotOverflow(thread, located.ownerSlotId!, newVersion, {
      messageIds: removedMessages,
      slotIds: removedSlots,
    })
    return change(thread, removedMessages, removedSlots)
  }

  const moved = located.entries.splice(located.index)
  located.entries.push({ slot: input.messageId })
  thread.slots[input.messageId] = {
    versions: [
      { version: 1, entries: moved },
      { version: newVersion, entries: [input.newAnswerMessageId] },
    ],
  }
  selection[input.messageId] = newVersion
  return change(thread, removedMessages, removedSlots)
}

/** 切版本：只改 selection。目标版不存在则原样返回（调用方可据此判断 no-op）。 */
export function setSlotVersion(thread: NodeThread, slotId: Id, version: number): NodeThread {
  const slot = thread.slots?.[slotId]
  if (!slot || !Array.isArray(slot.versions)) return thread
  if (!slot.versions.some((item) => item.version === version)) return thread
  // 缺省选择就是最新版，显式写成同一版不算变化
  const current = thread.selection?.[slotId] ?? latestVersionNumber(slot)
  if (current === version) return thread
  const next = cloneThread(thread)
  next.selection = { ...(next.selection ?? {}), [slotId]: version }
  return next
}

/** 沿显示路径最深一层的 entries 尾部追加（新消息落在当前选中版里）。 */
export function appendEntry(thread: NodeThread, ids: Id[]): NodeThread {
  if (ids.length === 0) return thread
  const next = cloneThread(thread)
  const visited = new Set<Id>()
  let entries = next.entries

  for (;;) {
    const last = entries[entries.length - 1]
    if (!isSlotEntry(last) || visited.has(last.slot)) break
    const slot = next.slots?.[last.slot] as ThreadSlot | undefined
    const chosen = findVersion(slot, next.selection?.[last.slot])
    if (!slot || !chosen) break
    visited.add(last.slot)
    entries = (chosen.version.entries ??= [])
  }

  entries.push(...ids)
  return next
}

function filterEntries(entries: ThreadEntry[], keep: (id: Id) => boolean): void {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (typeof entry === 'string' && !keep(entry)) entries.splice(i, 1)
  }
}

/** 摘掉某个悬空 id（这一轮失败到回答没落库时用）。 */
export function pruneEntry(thread: NodeThread, id: Id): NodeThread {
  const next = cloneThread(thread)
  filterEntries(next.entries, (entryId) => entryId !== id)
  for (const slot of Object.values(next.slots ?? {})) {
    for (const version of slot?.versions ?? []) {
      if (Array.isArray(version.entries)) filterEntries(version.entries, (entryId) => entryId !== id)
    }
  }
  return next
}

/** 清掉所有找不到消息实体的悬空 id（重试这一轮之前调用）。 */
export function pruneMissingEntries(thread: NodeThread, existing: Set<Id>): NodeThread {
  const next = cloneThread(thread)
  filterEntries(next.entries, (id) => existing.has(id))
  for (const slot of Object.values(next.slots ?? {})) {
    for (const version of slot?.versions ?? []) {
      if (Array.isArray(version.entries)) filterEntries(version.entries, (id) => existing.has(id))
    }
  }
  return next
}