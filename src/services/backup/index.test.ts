import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '@/data/dexie/db'
import { createDefaultSettings } from '@/domain/defaults'
import type { Asset, Message, Node } from '@/domain/models'
import { createReviewSession } from '@/domain/review/session'
import { BACKUP_TABLES, exportAllData, importAllData, parseDataBackup } from './index'

let source: AppDatabase
let target: AppDatabase

const node: Node = {
  id: 'n', projectId: 'p', parentId: null, forkFrom: null, title: '学习节点',
  position: { x: 123, y: 456 }, status: 'archived', createdAt: 1, updatedAt: 2,
  thread: {
    entries: ['question', { slot: 'answer' }],
    slots: { answer: { versions: [{ version: 1, entries: ['old'] }, { version: 2, entries: ['new'] }] } },
    selection: { answer: 1 },
  },
  mastery: { score: 70, updatedAt: 2 }, reviewEnrollment: 'enabled',
  review: { card: { due: 999, stability: 1, difficulty: 2, scheduledDays: 3, learningSteps: 0, reps: 1, lapses: 0, state: 'review' } },
}

beforeEach(async () => {
  source = new AppDatabase(`backup-source-${crypto.randomUUID()}`)
  target = new AppDatabase(`backup-target-${crypto.randomUUID()}`)
})

afterEach(async () => {
  await Promise.all([source.delete(), target.delete()])
})

async function seedAllData() {
  await source.projects.put({ id: 'p', name: '完整项目', tags: ['标签'], createdAt: 1, updatedAt: 2 })
  await source.projectSettings.put({ projectId: 'p', systemPrompt: '项目提示', agentToolPermission: 'prompt' })
  await source.nodes.put(node)
  const image: Asset = { id: 'image', projectId: 'p', kind: 'image', mime: 'image/png', createdAt: 1, blob: new Blob([new Uint8Array([0, 1, 128, 255])], { type: 'image/png' }) }
  await source.assets.put(image)
  const messages: Message[] = ['question', 'old', 'new'].map((id) => ({
    id, nodeId: 'n', projectId: 'p', role: id === 'question' ? 'user' : 'assistant', createdAt: 2,
    parts: id === 'question' ? [{ type: 'text', text: '问题' }, { type: 'image', assetId: 'image' }] : [
      { type: 'text', text: id }, { type: 'tool', callId: `${id}-tool`, name: 'read_node', input: { id: 'n' }, output: '完整工具结果' },
    ],
  }))
  await source.messages.bulkPut(messages)
  await source.notes.put({ id: 'note', projectId: 'p', nodeId: 'n', messageId: 'old', labels: ['没懂'], quote: 'old', start: 0, end: 3, createdAt: 1, updatedAt: 2 })
  const settings = createDefaultSettings()
  settings.backgroundProfile = '个人背景'
  settings.providers = [{ id: 'provider', label: '模型服务', kind: 'openai', apiKey: 'local-test-key', models: ['test-model'] }]
  await source.settings.put({ key: 'global', value: settings })
  await source.reviewSessions.put({ ...createReviewSession({ id: 'session', projectId: 'p', items: [{ nodeId: 'n', title: '主题', mode: 'review' }], origin: 'overview', now: 2 }), open: 1 })
  await source.composerDrafts.put({ id: 'n', projectId: 'p', nodeId: 'n', text: '未发送的输入', quotes: ['引用'], assets: [{ ...image, id: 'draft-image' }], updatedAt: 2 })
  await source.freeAskConversations.put({ id: 'conversation', projectId: 'p', title: '自由问答', createdAt: 1, updatedAt: 2 })
  await source.freeAskMessages.put({ id: 'free-message', conversationId: 'conversation', projectId: 'p', role: 'assistant', text: '问答内容', createdAt: 1, updatedAt: 2, imageIds: ['image'] })
  await source.freeAskLocal.put({ id: 'free-local', projectId: 'p', activeConversationId: 'conversation', draft: '草稿', pendingImages: [{ ...image, id: 'free-draft-image' }] })
  await source.modelCatalog.put({ key: 'models.dev', raw: { provider: { models: ['test-model'] } }, fetchedAt: 2 })
  await source.syncState.put({ key: 'sync', cursor: 987, lastSyncedAt: 123, initialized: true })
  await source.outbox.add({ entity: 'project', localId: 'p', op: 'delete', updatedAt: 1 })
}

describe('complete data backup', () => {
  it('covers all data tables and restores binary images, drafts, versions, tool results and settings intact', async () => {
    await seedAllData()
    const dataTables = source.tables.map((table) => table.name).filter((name) => name !== 'outbox' && name !== 'syncState')
    expect([...BACKUP_TABLES].sort()).toEqual(dataTables.sort())
    const content = await exportAllData(source)
    expect(content).not.toContain('"cursor":987')
    await importAllData(parseDataBackup(content), target)
    // Serializing both snapshots compares every record, including all nested binary
    // images. Only the backup creation time differs.
    const original = JSON.parse(content)
    const restored = JSON.parse(await exportAllData(target))
    expect(restored.tables).toEqual(original.tables)
    expect(await target.nodes.get('n')).toEqual(node)
    expect(await (await target.assets.get('image'))!.blob.arrayBuffer()).toEqual(new Uint8Array([0, 1, 128, 255]).buffer)
    expect(await target.syncState.count()).toBe(0)
    expect(await target.outbox.count()).toBe(10)
  })

  it('merges matching records without removing other projects or replaying source sync state', async () => {
    await seedAllData()
    await target.projects.put({ id: 'other', name: '现有项目', tags: [], createdAt: 1, updatedAt: 1 })
    await target.nodes.put({ ...node, title: '现有节点', updatedAt: Date.now() + 100_000 })
    const futureStamp = Date.now() + 200_000
    await target.outbox.add({ entity: 'node', localId: 'n', op: 'delete', updatedAt: futureStamp })
    const state = { key: 'sync', cursor: 42, lastSyncedAt: 50, initialized: true }
    await target.syncState.put(state)
    await target.outbox.add({ entity: 'project', localId: 'unrelated-deletion', op: 'delete', updatedAt: 10 })
    const backup = parseDataBackup(await exportAllData(source))
    await importAllData(backup, target)
    expect(await target.projects.count()).toBe(2)
    expect((await target.nodes.get('n'))?.title).toBe(node.title)
    expect(await target.syncState.get('sync')).toEqual(state)
    const pending = await target.outbox.where('[entity+localId]').equals(['node', 'n']).toArray()
    expect(pending).toHaveLength(1)
    expect(pending[0].op).toBe('upsert')
    expect(pending[0].updatedAt).toBeGreaterThan(futureStamp)
    expect(await target.outbox.where('localId').equals('unrelated-deletion').count()).toBe(1)
    await importAllData(backup, target)
    expect(await target.projects.count()).toBe(2)
    expect(await target.reviewSessions.where('[projectId+open]').equals(['p', 1]).count()).toBe(1)
  })

  it('preserves review history while keeping only one unfinished session per project', async () => {
    await seedAllData()
    await target.reviewSessions.put({ ...createReviewSession({ id: 'newer', projectId: 'p', items: [], origin: 'overview', now: 10 }), open: 1 })
    await importAllData(parseDataBackup(await exportAllData(source)), target)
    expect(await target.reviewSessions.count()).toBe(2)
    expect((await target.reviewSessions.get('session'))?.status).toBe('ended')
    expect((await target.reviewSessions.get('newer'))?.open).toBe(1)
  })

  it('rolls back all tables and sync operations when a write fails midway', async () => {
    await seedAllData()
    const backup = parseDataBackup(await exportAllData(source))
    await target.projects.put({ id: 'p', name: '导入前的项目', tags: [], createdAt: 1, updatedAt: 1 })
    const before = JSON.parse(await exportAllData(target)).tables
    target.freeAskLocal.hook('creating', () => { throw new Error('simulated write failure') })
    await expect(importAllData(backup, target)).rejects.toThrow('simulated write failure')
    expect(JSON.parse(await exportAllData(target)).tables).toEqual(before)
    expect(await target.outbox.count()).toBe(0)
  })

  it('rejects malformed, partial, incompatible and duplicate backups before writing', async () => {
    await seedAllData()
    const content = await exportAllData(source)
    const modify = (mutate: (data: ReturnType<typeof JSON.parse>) => void) => {
      const data = JSON.parse(content)
      mutate(data)
      return JSON.stringify(data)
    }
    const invalid = [
      'not json', '{}', '{"type":"project","version":2}',
      modify((data) => { data.version = 2 }),
      modify((data) => { delete data.tables.composerDrafts }),
      modify((data) => { data.tables.projects.push(data.tables.projects[0]) }),
      modify((data) => { data.tables.messages[0].parts = [{ type: 'text', text: 123 }] }),
      modify((data) => { data.tables.assets[0].blob.__opentreelearnBlob.base64 = '?' }),
      modify((data) => { data.tables.messages[0].projectId = 'missing' }),
      modify((data) => { data.tables.freeAskMessages[0].conversationId = 'missing' }),
    ]
    for (const file of invalid) expect(() => parseDataBackup(file)).toThrow()
    expect(await target.projects.count()).toBe(0)
  })
})
