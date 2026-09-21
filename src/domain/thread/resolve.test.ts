import { describe, expect, it } from 'vitest'
import type { Message, Node, NodeThread } from '@/domain/models'
import { linearMessages, makeMessage, makeNode } from '@/test/fixtures'
import {
  resolveThread,
  staleSelectionSlots,
  summarizeSlotVersions,
} from './resolve'

const linear = linearMessages

function user(id: string, createdAt: number): Message {
  return makeMessage({ id, nodeId: 'n1', role: 'user', createdAt })
}

function assistant(id: string, createdAt: number): Message {
  return makeMessage({ id, nodeId: 'n1', role: 'assistant', createdAt })
}

function withThread(thread?: NodeThread): Node {
  return makeNode({ id: 'n1', thread })
}

describe('resolveThread', () => {
  it('degrades to a linear path without a thread', () => {
    const messages = linear(2)
    const resolved = resolveThread(withThread(), [...messages].reverse())

    expect(resolved.path.map((message) => message.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(resolved.versions.size).toBe(0)
  })

  it('degrades to a linear path when the thread is malformed', () => {
    const broken = { entries: 'nope', slots: null } as unknown as NodeThread
    const resolved = resolveThread(withThread(broken), linear(1))
    expect(resolved.path.map((message) => message.id)).toEqual(['u1', 'a1'])
    expect(resolved.versions.size).toBe(0)
  })

  it('degrades to a linear path when nothing in the thread resolves', () => {
    const thread: NodeThread = {
      entries: [{ slot: 'ghost' }],
      slots: { ghost: { versions: [{ version: 1, entries: ['missing'] }] } },
    }
    const resolved = resolveThread(withThread(thread), linear(1))
    expect(resolved.path.map((message) => message.id)).toEqual(['u1', 'a1'])
    expect(resolved.versions.size).toBe(0)
  })

  it('expands a single edit slot and keys the version by its first message', () => {
    const thread: NodeThread = {
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
    }
    const resolved = resolveThread(withThread(thread), linear(2))

    expect(resolved.path.map((message) => message.id)).toEqual(['u2', 'a2'])
    expect(resolved.versions.get('u2')).toEqual({ slotId: 'u1', index: 1, total: 2 })
  })

  it('switches versions by selection', () => {
    const thread: NodeThread = {
      entries: [{ slot: 'u1' }],
      slots: {
        u1: {
          versions: [
            { version: 1, entries: ['u1', 'a1'] },
            { version: 2, entries: ['u2', 'a2'] },
          ],
        },
      },
      selection: { u1: 1 },
    }
    const resolved = resolveThread(withThread(thread), linear(2))

    expect(resolved.path.map((message) => message.id)).toEqual(['u1', 'a1'])
    expect(resolved.versions.get('u1')).toEqual({ slotId: 'u1', index: 0, total: 2 })
  })

  it('keeps the shared question outside a regenerate slot', () => {
    const thread: NodeThread = {
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
    }
    const resolved = resolveThread(withThread(thread), linear(2))

    expect(resolved.path.map((message) => message.id)).toEqual(['u1', 'a2'])
    expect(resolved.versions.get('a2')).toEqual({ slotId: 'a1', index: 1, total: 2 })
  })

  it('nests slots inside old versions and still resolves the deepest one', () => {
    const thread: NodeThread = {
      entries: [{ slot: 'u1' }],
      slots: {
        u1: {
          versions: [
            { version: 1, entries: ['u1', 'a1'] },
            { version: 2, entries: ['u2', 'a2', { slot: 'u3' }] },
          ],
        },
        u3: {
          versions: [
            { version: 1, entries: ['u3', 'a3'] },
            { version: 3, entries: ['u4', 'a4'] },
          ],
        },
      },
      selection: { u1: 2, u3: 3 },
    }
    const messages = [...linear(2), user('u3', 5), assistant('a3', 6), user('u4', 7), assistant('a4', 8)]
    const resolved = resolveThread(withThread(thread), messages)

    expect(resolved.path.map((message) => message.id)).toEqual(['u2', 'a2', 'u4', 'a4'])
    expect(resolved.versions.get('u2')).toEqual({ slotId: 'u1', index: 1, total: 2 })
    expect(resolved.versions.get('u4')).toEqual({ slotId: 'u3', index: 1, total: 2 })
  })

  it('does not report a version divider for a single-version slot', () => {
    // 正常数据不会出现单版槽（建槽就是两版起），这里防导入/坏数据渲染出「< 1/1 >」
    const thread: NodeThread = {
      entries: [{ slot: 'u1' }],
      slots: { u1: { versions: [{ version: 1, entries: ['u1', 'a1'] }] } },
    }
    const resolved = resolveThread(withThread(thread), linear(1))

    expect(resolved.path.map((message) => message.id)).toEqual(['u1', 'a1'])
    expect(resolved.versions.size).toBe(0)
  })

  it('keeps the divider reachable when the selected version is still empty', () => {
    // 重新生成失败、新回答没落库：这一版暂时是空的，横线要挂到共享的提问上，
    // 否则用户没有入口切回旧回答
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
    const resolved = resolveThread(withThread(thread), linear(1))

    expect(resolved.path.map((message) => message.id)).toEqual(['u1'])
    expect(resolved.versions.get('u1')).toEqual({ slotId: 'a1', index: 1, total: 2 })
  })

  it('skips dangling ids and empty slots', () => {
    const thread: NodeThread = {
      entries: ['u1', 'missing', { slot: 'gone' }, { slot: 'a1' }],
      slots: {
        a1: { versions: [{ version: 2, entries: ['a1', 'also-missing'] }] },
      },
    }
    const resolved = resolveThread(withThread(thread), linear(1))

    expect(resolved.path.map((message) => message.id)).toEqual(['u1', 'a1'])
  })

  it('falls back to the latest version when the selected one was pruned', () => {
    const thread: NodeThread = {
      entries: [{ slot: 'u1' }],
      slots: {
        u1: {
          versions: [
            { version: 2, entries: ['u2', 'a2'] },
            { version: 3, entries: ['u3', 'a3'] },
          ],
        },
      },
      selection: { u1: 1 },
    }
    const messages = [...linear(1), user('u2', 3), assistant('a2', 4), user('u3', 5), assistant('a3', 6)]
    const resolved = resolveThread(withThread(thread), messages)

    expect(resolved.path.map((message) => message.id)).toEqual(['u3', 'a3'])
    expect(resolved.versions.get('u3')).toEqual({ slotId: 'u1', index: 1, total: 2 })
  })

  it('prefers a frozen selection for forked nodes', () => {
    const thread: NodeThread = {
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
    }
    const node = withThread(thread)
    const messages = linear(2)

    expect(resolveThread(node, messages).path.map((message) => message.id)).toEqual(['u2', 'a2'])
    expect(
      resolveThread(node, messages, { u1: 1 }).path.map((message) => message.id),
    ).toEqual(['u1', 'a1'])
  })

  it('cuts cyclic data instead of looping forever', () => {
    const thread: NodeThread = {
      entries: ['u1', { slot: 'loop' }],
      slots: { loop: { versions: [{ version: 1, entries: ['a1', { slot: 'loop' }] }] } },
    }
    const resolved = resolveThread(withThread(thread), linear(1))
    expect(resolved.path.map((message) => message.id)).toEqual(['u1', 'a1'])
  })
})

describe('summarizeSlotVersions', () => {
  it('reports the first message of every version, null for empty ones', () => {
    const thread: NodeThread = {
      entries: [{ slot: 'u1' }],
      slots: {
        u1: {
          versions: [
            { version: 1, entries: ['u1', 'a1'] },
            { version: 2, entries: [] },
            { version: 3, entries: ['missing', 'u3', 'a3'] },
          ],
        },
      },
      selection: { u1: 3 },
    }
    const messages = [...linear(1), user('u3', 5), assistant('a3', 6)]

    expect(summarizeSlotVersions(withThread(thread), messages, 'u1')).toEqual([
      { version: 1, index: 0, messageId: 'u1' },
      { version: 2, index: 1, messageId: null },
      { version: 3, index: 2, messageId: 'u3' },
    ])
    expect(summarizeSlotVersions(withThread(thread), messages, 'ghost')).toEqual([])
  })
})

describe('staleSelectionSlots', () => {
  const thread: NodeThread = {
    entries: [{ slot: 'u1' }],
    slots: { u1: { versions: [{ version: 2, entries: ['u1'] }] } },
  }

  it('flags frozen version numbers that no longer exist', () => {
    const node = withThread(thread)
    expect(staleSelectionSlots(node, { u1: 2 })).toEqual([])
    expect(staleSelectionSlots(node, { u1: 1 })).toEqual(['u1'])
    expect(staleSelectionSlots(node, { ghost: 1 })).toEqual(['ghost'])
    expect(staleSelectionSlots(withThread(), { u1: 1 })).toEqual(['u1'])
    expect(staleSelectionSlots(node, undefined)).toEqual([])
  })
})