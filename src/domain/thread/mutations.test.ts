import { describe, expect, it } from 'vitest'
import type { Message, Node, NodeThread } from '@/domain/models'
import { linearMessages, makeMessage, makeNode } from '@/test/fixtures'
import { resolveThread } from './resolve'
import {
  MAX_THREAD_VERSIONS,
  appendEntry,
  collectSlotMessages,
  createEditVersion,
  openAnswerVersion,
  pruneEntry,
  pruneMissingEntries,
  setSlotVersion,
  type ThreadChange,
} from './mutations'

function withThread(thread?: NodeThread): Node {
  return makeNode({ id: 'n1', thread })
}

/** 把「新版本里那条还没落库的消息」补进消息表：resolve 只认真实存在的消息。 */
function extend(messages: Message[], ids: string[]): Message[] {
  const next = [...messages]
  let createdAt = next.reduce((max, message) => Math.max(max, message.createdAt), 0)
  for (const id of ids) {
    if (next.some((message) => message.id === id)) continue
    createdAt += 1
    next.push(
      makeMessage({
        id,
        nodeId: 'n1',
        role: id.startsWith('u') ? 'user' : 'assistant',
        createdAt,
      }),
    )
  }
  return next
}

function edit(node: Node, messages: Message[], messageId: string, newUser: string, newAnswer: string): ThreadChange {
  const change = createEditVersion({
    node,
    messages,
    messageId,
    newUserMessageId: newUser,
    newAnswerMessageId: newAnswer,
  })
  expect(change).not.toBeNull()
  return change!
}

function regenerate(node: Node, messages: Message[], messageId: string, newAnswer: string): ThreadChange {
  const change = openAnswerVersion({ node, messages, messageId, newAnswerMessageId: newAnswer })
  expect(change).not.toBeNull()
  return change!
}

function pathIds(node: Node, messages: Message[]): string[] {
  return resolveThread(node, messages).path.map((message) => message.id)
}

describe('createEditVersion', () => {
  it('lazily builds the thread and replaces the whole tail with a new version', () => {
    const messages = extend(linearMessages(1), ['u2', 'a2'])
    const change = edit(withThread(), linearMessages(1), 'u1', 'u2', 'a2')

    expect(change.thread).toEqual({
      entries: [{ slot: 'u1' }],
      slots: {
        u1: {
          versions: [
            { version: 1, entries: ['u1', 'a1'] },
            { version: 2, entries: ['u2', 'a2'] },
          ],
        },
      },
      selection: { u1: 2 },
    })
    expect(change.removedMessageIds).toEqual([])

    const node = withThread(change.thread)
    expect(pathIds(node, messages)).toEqual(['u2', 'a2'])

    const back = withThread(setSlotVersion(change.thread, 'u1', 1))
    expect(pathIds(back, messages)).toEqual(['u1', 'a1'])
  })

  it('edits a message in the middle of an old version by nesting a slot there', () => {
    const messages = extend(linearMessages(4), ['u5', 'a5', 'u6', 'a6'])
    const first = edit(withThread(), messages.slice(0, 4), 'u1', 'u5', 'a5')
    const thread = appendEntry(first.thread, ['u3', 'a3'])
    // 版本 2 里这段对话是 u5 a5 u3 a3，编辑 u3 应该只影响它之后的整段
    const second = edit(withThread(thread), messages, 'u3', 'u6', 'a6')

    expect(second.thread.entries).toEqual([{ slot: 'u1' }])
    expect(second.thread.slots.u1.versions[1].entries).toEqual([
      'u5',
      'a5',
      { slot: 'u3' },
    ])
    expect(second.thread.slots.u3).toEqual({
      versions: [
        { version: 1, entries: ['u3', 'a3'] },
        { version: 3, entries: ['u6', 'a6'] },
      ],
    })
    expect(second.thread.selection).toEqual({ u1: 2, u3: 3 })

    const node = withThread(second.thread)
    expect(pathIds(node, messages)).toEqual(['u5', 'a5', 'u6', 'a6'])
    expect(resolveThread(node, messages).versions.get('u6')).toEqual({
      slotId: 'u3',
      index: 1,
      total: 2,
    })
    // 切回外层旧版：内层槽整段隐藏，回到最初的 u1 a1 u2 a2
    expect(pathIds(withThread(setSlotVersion(second.thread, 'u1', 1)), messages)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ])
  })

  it('rejoins the same slot when editing the first message of a version again', () => {
    const messages = extend(linearMessages(1), ['u2', 'a2', 'u5', 'a5'])
    const first = edit(withThread(), linearMessages(1), 'u1', 'u2', 'a2')
    const oldVersion = withThread(setSlotVersion(first.thread, 'u1', 1))
    const second = edit(oldVersion, messages, 'u1', 'u5', 'a5')

    expect(second.thread.slots.u1.versions).toEqual([
      { version: 1, entries: ['u1', 'a1'] },
      { version: 2, entries: ['u2', 'a2'] },
      { version: 3, entries: ['u5', 'a5'] },
    ])
    expect(second.thread.selection).toEqual({ u1: 3 })
    expect(pathIds(withThread(second.thread), messages)).toEqual(['u5', 'a5'])
  })

  it('keeps at most three versions, evicting the oldest and cascading into nested slots', () => {
    const messages = extend(linearMessages(3), ['u4', 'a4', 'u5', 'a5', 'u6', 'a6', 'u7', 'a7'])
    const one = edit(withThread(), linearMessages(3), 'u3', 'u4', 'a4')
    const two = edit(withThread(one.thread), messages, 'u1', 'u5', 'a5')
    const old = withThread(setSlotVersion(two.thread, 'u1', 1))
    const three = edit(old, messages, 'u1', 'u6', 'a6')
    const four = edit(withThread(three.thread), messages, 'u1', 'u7', 'a7')

    expect(four.thread.slots.u1.versions.map((version) => version.version)).toEqual([3, 4, 5])
    expect(four.thread.slots.u3).toBeUndefined()
    expect(four.thread.selection).toEqual({ u1: 5 })
    // v1 里的 u1 a1 u2 a2 与嵌套槽 u3 的 u3 a3 u4 a4 一起被淘汰
    expect([...four.removedMessageIds].sort()).toEqual(
      ['a1', 'a2', 'a3', 'a4', 'u1', 'u2', 'u3', 'u4'].sort(),
    )
    expect(four.removedSlotIds).toEqual(['u3'])
    expect(MAX_THREAD_VERSIONS).toBe(3)

    const remaining = four.thread.slots.u1.versions.flatMap((version) => version.entries)
    expect(remaining).toEqual(['u5', 'a5', 'u6', 'a6', 'u7', 'a7'])
    expect(pathIds(withThread(four.thread), messages)).toEqual(['u7', 'a7'])
  })
})

describe('openAnswerVersion', () => {
  it('keeps the shared question out of the versions', () => {
    const messages = extend(linearMessages(1), ['a2'])
    const change = regenerate(withThread(), linearMessages(1), 'a1', 'a2')

    expect(change.thread).toEqual({
      entries: ['u1', { slot: 'a1' }],
      slots: {
        a1: {
          versions: [
            { version: 1, entries: ['a1'] },
            { version: 2, entries: ['a2'] },
          ],
        },
      },
      selection: { a1: 2 },
    })
    expect(change.removedMessageIds).toEqual([])

    const node = withThread(change.thread)
    expect(pathIds(node, messages)).toEqual(['u1', 'a2'])
    expect(resolveThread(node, messages).versions.get('a2')).toEqual({
      slotId: 'a1',
      index: 1,
      total: 2,
    })
    expect(pathIds(withThread(setSlotVersion(change.thread, 'a1', 1)), messages)).toEqual([
      'u1',
      'a1',
    ])
  })

  it('stacks consecutive regenerations in one slot and prunes the oldest answer', () => {
    const messages = extend(linearMessages(1), ['a2', 'a3', 'a4'])
    const one = regenerate(withThread(), linearMessages(1), 'a1', 'a2')
    const two = regenerate(withThread(one.thread), messages, 'a2', 'a3')
    expect(two.thread.slots.a1.versions.map((version) => version.version)).toEqual([1, 2, 3])

    const three = regenerate(withThread(two.thread), messages, 'a3', 'a4')
    expect(three.thread.slots.a1.versions.map((version) => version.version)).toEqual([2, 3, 4])
    expect(three.removedMessageIds).toEqual(['a1'])
    expect(pathIds(withThread(three.thread), messages)).toEqual(['u1', 'a4'])
  })
})

describe('setSlotVersion', () => {
  const thread: NodeThread = {
    entries: [{ slot: 'u1' }],
    slots: {
      u1: {
        versions: [
          { version: 1, entries: ['u1'] },
          { version: 2, entries: ['u2'] },
        ],
      },
    },
  }

  it('updates the selection only', () => {
    const next = setSlotVersion(thread, 'u1', 1)
    expect(next.selection).toEqual({ u1: 1 })
    expect(next.entries).toEqual(thread.entries)
  })

  it('ignores unknown slots, unknown versions and the already-selected version', () => {
    expect(setSlotVersion(thread, 'ghost', 1)).toBe(thread)
    expect(setSlotVersion(thread, 'u1', 9)).toBe(thread)
    // 缺省选择就是最新版
    expect(setSlotVersion(thread, 'u1', 2)).toBe(thread)
  })
})

describe('appendEntry / pruneEntry', () => {
  it('appends to the deepest selected version', () => {
    const thread: NodeThread = {
      entries: [{ slot: 'u1' }],
      slots: {
        u1: {
          versions: [
            { version: 1, entries: ['u1'] },
            { version: 2, entries: ['u2', 'a2'] },
          ],
        },
      },
      selection: { u1: 2 },
    }
    const next = appendEntry(thread, ['u3', 'a3'])
    expect(next.slots.u1.versions[1].entries).toEqual(['u2', 'a2', 'u3', 'a3'])
    expect(next.entries).toEqual([{ slot: 'u1' }])
  })

  it('appends into an empty selected version', () => {
    const thread: NodeThread = {
      entries: ['u1', { slot: 'a1' }],
      slots: {
        a1: {
          versions: [
            { version: 1, entries: ['a1'] },
            { version: 2, entries: [] },
          ],
        },
      },
      selection: { a1: 2 },
    }
    const next = appendEntry(thread, ['a2'])
    expect(next.slots.a1.versions[1].entries).toEqual(['a2'])
  })

  it('prunes one dangling id and all missing ids', () => {
    const thread: NodeThread = {
      entries: ['u1', 'ghost', { slot: 'a1' }],
      slots: {
        a1: {
          versions: [
            { version: 1, entries: ['a1', 'other-ghost'] },
            { version: 2, entries: ['a2'] },
          ],
        },
      },
      selection: { a1: 2 },
    }

    expect(pruneEntry(thread, 'ghost').entries).toEqual(['u1', { slot: 'a1' }])
    const cleaned = pruneMissingEntries(thread, new Set(['u1', 'a1', 'a2']))
    expect(cleaned.entries).toEqual(['u1', { slot: 'a1' }])
    expect(cleaned.slots.a1.versions[0].entries).toEqual(['a1'])
  })
})

describe('collectSlotMessages', () => {
  it('walks nested slots of every version', () => {
    const thread: NodeThread = {
      entries: [{ slot: 'u1' }],
      slots: {
        u1: {
          versions: [
            { version: 1, entries: ['u1', { slot: 'a1' }] },
            { version: 2, entries: ['u2', 'a2'] },
          ],
        },
        a1: {
          versions: [
            { version: 1, entries: ['a1'] },
            { version: 3, entries: ['a3'] },
          ],
        },
      },
    }
    expect([...collectSlotMessages(thread, 'u1')].sort()).toEqual(
      ['a1', 'a2', 'a3', 'u1', 'u2'].sort(),
    )
    expect(collectSlotMessages(thread, 'ghost')).toEqual([])
  })
})