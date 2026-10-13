import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './dexie/db'
import { createDexieRepositories, purgeProject } from './dexie/repos'
import { createSyncLocal, importRecordsInto } from './sync-local'
import type { FreeAskMessage } from '@/domain/review/free-ask'

const databases: AppDatabase[] = []
function device() {
  const db = new AppDatabase('free-ask-sync-' + crypto.randomUUID())
  databases.push(db)
  return { db, repositories: createDexieRepositories(db), sync: createSyncLocal(db) }
}
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.delete())) })

const conversation = { id: 'c1', projectId: 'p1', title: '', createdAt: 1, updatedAt: 1 }
function message(id: string, text: string, role: FreeAskMessage['role'] = 'user'): FreeAskMessage {
  return { id, conversationId: 'c1', projectId: 'p1', role, text, createdAt: Date.now(), updatedAt: Date.now() }
}
async function transfer(from: ReturnType<typeof device>, to: ReturnType<typeof device>) {
  const entries = await from.sync.readOutbox()
  for (const entry of entries) {
    const payload = await from.sync.loadPayload(entry.entity, entry.localId)
    await to.sync.applyRemote({ entity: entry.entity, id: entry.localId, rev: entry.seq!, updatedAt: entry.updatedAt,
      deletedAt: entry.op === 'delete' ? entry.updatedAt : null, data: payload?.data ?? {},
    })
  }
  await from.sync.clearOutbox(entries.map((entry) => entry.seq!))
}

describe('自由问答持久化与同步', () => {
  it('两台设备通过台账同步历史和 Mermaid，草稿留在本机，独立新增消息均保留', async () => {
    const a = device(), b = device()
    await a.repositories.freeAsk.create(conversation)
    await a.repositories.freeAsk.saveMessage(message('q1', '画一个 DAG'))
    const diagram = '```mermaid\nflowchart LR\n A-->B\n```'
    await a.repositories.freeAsk.saveMessage(message('a1', diagram, 'assistant'))
    await a.repositories.freeAsk.saveLocal({ id: 'c1', projectId: 'p1', draft: '未发送的问题' })
    await transfer(a, b)
    expect((await b.repositories.freeAsk.listByProject('p1'))[0].title).toBe('画一个 DAG')
    expect((await b.repositories.freeAsk.listMessages('c1')).map((entry) => entry.text)).toEqual(['画一个 DAG', diagram])
    expect(await b.repositories.freeAsk.getLocal('c1')).toBeUndefined()
    expect(await b.sync.outboxCount()).toBe(0)
    await a.repositories.freeAsk.saveMessage(message('qa', '设备 A 新问题'))
    await b.repositories.freeAsk.saveMessage(message('qb', '设备 B 新问题'))
    await transfer(a, b)
    await transfer(b, a)
    for (const peer of [a, b]) {
      expect((await peer.repositories.freeAsk.listMessages('c1')).map((entry) => entry.id).sort()).toEqual(['a1', 'q1', 'qa', 'qb'])
    }
  })

  it('首次登录合并会搬运历史，随后能记入同步台账', async () => {
    const guest = device(), account = device()
    await guest.repositories.freeAsk.create(conversation)
    await guest.repositories.freeAsk.saveMessage(message('q1', '游客提问'))
    await guest.repositories.freeAsk.saveLocal({ id: 'c1', projectId: 'p1', draft: '游客草稿' })
    await importRecordsInto(account.db, guest.db)
    await account.sync.recordAllLocal()
    expect(await account.repositories.freeAsk.listMessages('c1')).toHaveLength(1)
    expect(await account.repositories.freeAsk.getLocal('c1')).toMatchObject({ draft: '游客草稿' })
    expect((await account.sync.readOutbox()).map((entry) => entry.entity)).toEqual(expect.arrayContaining(['freeAskConversation', 'freeAskMessage']))
  })

  it('删除项目会清理历史、草稿并同步删除；云端覆盖会清空这些本地表', async () => {
    const a = device(), b = device()
    await a.repositories.projects.create({ id: 'p1', name: '图论', tags: [], createdAt: 1, updatedAt: 1 })
    await a.repositories.freeAsk.create(conversation)
    await a.repositories.freeAsk.saveMessage(message('q1', '提问'))
    await a.repositories.freeAsk.saveLocal({ id: 'c1', projectId: 'p1', draft: '草稿' })
    await transfer(a, b)
    await purgeProject(a.db, 'p1')
    expect(await a.db.freeAskConversations.count()).toBe(0)
    expect(await a.db.freeAskMessages.count()).toBe(0)
    expect(await a.db.freeAskLocal.count()).toBe(0)
    expect((await a.sync.readOutbox()).filter((entry) => entry.entity.startsWith('freeAsk')).every((entry) => entry.op === 'delete')).toBe(true)
    await transfer(a, b)
    expect(await b.db.freeAskConversations.count()).toBe(0)
    expect(await b.db.freeAskMessages.count()).toBe(0)
    await b.repositories.freeAsk.create(conversation)
    await b.repositories.freeAsk.saveMessage(message('q2', '新提问'))
    await b.repositories.freeAsk.saveLocal({ id: 'c1', projectId: 'p1', draft: '草稿' })
    await b.sync.clearLocalData()
    expect(await b.db.freeAskConversations.count()).toBe(0)
    expect(await b.db.freeAskMessages.count()).toBe(0)
    expect(await b.db.freeAskLocal.count()).toBe(0)
  })

  it('损坏或主键不一致的远端消息不能破坏本机历史', async () => {
    const a = device()
    for (const data of [{ id: 'bad' }, { ...message('another-id', '坏数据') }]) {
      expect(await a.sync.applyRemote({ entity: 'freeAskMessage', id: 'bad', rev: 1, updatedAt: 1, deletedAt: null, data })).toBe('skipped')
    }
    expect(await a.db.freeAskMessages.count()).toBe(0)
  })
})
