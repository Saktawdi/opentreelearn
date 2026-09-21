import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Message, Node } from '@/domain/models'
import type { WireChange } from '@/domain/sync'
import { resolveThread } from '@/domain/thread/resolve'
import { AppDatabase } from './dexie/db'
import { createDexieRepositories } from './dexie/repos'
import { createSyncLocal, type SyncLocal } from './sync-local'

let db: AppDatabase
let sync: SyncLocal
let repositories: ReturnType<typeof createDexieRepositories>

function threadNode(id: string, projectId: string, updatedAt = 1): Node {
  return {
    id,
    projectId,
    parentId: null,
    forkFrom: null,
    title: id,
    position: null,
    status: 'active',
    thread: {
      entries: [{ slot: 'u1' }, 'u2'],
      slots: {
        u1: {
          versions: [
            { version: 1, entries: ['u1', 'a1'] },
            { version: 2, entries: ['u1b', 'a1b'] },
          ],
        },
      },
      selection: { u1: 1 },
    },
    createdAt: 1,
    updatedAt,
  }
}

function message(id: string, role: Message['role'], createdAt = 1): Message {
  return {
    id,
    nodeId: 'n1',
    projectId: 'p1',
    role,
    parts: [{ type: 'text', text: id }],
    createdAt,
    updatedAt: createdAt,
  }
}

function remote(change: Partial<WireChange> & Pick<WireChange, 'entity' | 'id'>): WireChange {
  return { rev: 1, updatedAt: 100, deletedAt: null, data: {}, ...change }
}

beforeEach(() => {
  db = new AppDatabase(`test-thread-sync-${Math.random().toString(36).slice(2)}`)
  sync = createSyncLocal(db)
  repositories = createDexieRepositories(db)
})

describe('thread 走同步通道', () => {
  it('节点改 thread（编辑/切版）记一条 node upsert，载荷里带得上 thread', async () => {
    await repositories.nodes.create(threadNode('n1', 'p1'))
    await sync.clearOutbox((await sync.readOutbox()).map((entry) => entry.seq as number))

    await repositories.nodes.update('n1', { thread: { entries: ['u1'], slots: {}, selection: {} } })

    const entries = await sync.readOutbox()
    expect(entries.map((entry) => `${entry.entity}:${entry.op}`)).toEqual(['node:upsert'])
    const payload = await sync.loadPayload('node', 'n1')
    expect((payload?.data.thread as { entries: unknown[] }).entries).toEqual(['u1'])
  })

  it('远端 node 载荷带 thread ⇒ 解出版本路径；随后切版会改本地选择', async () => {
    await sync.applyRemote(
      remote({ entity: 'node', id: 'n1', updatedAt: 500, data: threadNode('n1', 'p1', 500) }),
    )
    for (const m of [
      message('u1', 'user'),
      message('a1', 'assistant', 2),
      message('u1b', 'user'),
      message('a1b', 'assistant', 2),
      message('u2', 'user', 3),
    ]) {
      await sync.applyRemote(remote({ entity: 'message', id: m.id, updatedAt: 500, data: m }))
    }

    const node = await repositories.nodes.get('n1')
    expect(node).toBeDefined()
    const messages = await repositories.messages.listByNode('n1')
    expect(resolveThread(node!, messages).path.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])

    await repositories.nodes.update('n1', { thread: { ...node!.thread!, selection: { u1: 2 } } })
    const after = await repositories.nodes.get('n1')
    expect(resolveThread(after!, messages).path.map((m) => m.id)).toEqual(['u1b', 'a1b', 'u2'])
  })

  it('淘汰版本级联删消息后，删除经 outbox 推到云端', async () => {
    await repositories.nodes.create(threadNode('n1', 'p1'))
    await repositories.messages.createMany([message('u1', 'user'), message('a1', 'assistant', 2)])
    await sync.clearOutbox((await sync.readOutbox()).map((entry) => entry.seq as number))

    await repositories.messages.remove('a1')
    await repositories.notes.removeByMessage('a1')

    expect((await sync.readOutbox()).map((entry) => `${entry.entity}:${entry.localId}:${entry.op}`)).toEqual([
      'message:a1:delete',
    ])
  })

  it('forkFrom.selection 冻结点随 node 载荷上行，账号库之间一致', async () => {
    const forkNode = threadNode('n2', 'p1', 900)
    forkNode.forkFrom = { nodeId: 'n1', messageId: 'u1', selection: { u1: 2 } }
    await sync.applyRemote(remote({ entity: 'node', id: 'n2', updatedAt: 900, data: forkNode }))

    const stored = await repositories.nodes.get('n2')
    expect(stored?.forkFrom?.selection).toEqual({ u1: 2 })
    const payload = await sync.loadPayload('node', 'n2')
    expect((payload?.data.forkFrom as { selection: unknown }).selection).toEqual({ u1: 2 })
  })

  it('老数据/老客户端的 node 载荷没有 thread ⇒ 解成线性，仍可继续同步', async () => {
    const legacy = threadNode('n3', 'p1', 700)
    delete (legacy as { thread?: unknown }).thread
    await sync.applyRemote(remote({ entity: 'node', id: 'n3', updatedAt: 700, data: legacy }))
    await sync.applyRemote(
      remote({
        entity: 'message',
        id: 'm1',
        updatedAt: 700,
        data: { ...message('m1', 'user'), nodeId: 'n3' },
      }),
    )

    const node = await repositories.nodes.get('n3')
    expect(node?.thread).toBeUndefined()
    expect(resolveThread(node!, await repositories.messages.listByNode('n3')).path).toHaveLength(1)
  })
})
