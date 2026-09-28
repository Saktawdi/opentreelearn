import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './db'
import { createComposerDraftRepository } from './composer-drafts'
import { isEmptyDraft, type ComposerDraft } from '@/domain/composer/draft'
import type { Asset } from '@/domain/models'

const NOW = 1700000000000

function makeAsset(id: string, projectId: string, body: string): Asset {
  return {
    id,
    projectId,
    kind: 'image',
    mime: 'image/jpeg',
    createdAt: NOW,
    blob: new Blob([body], { type: 'image/jpeg' }),
  }
}

function makeDraft(nodeId: string, projectId = 'p1', patch: Partial<ComposerDraft> = {}): ComposerDraft {
  return {
    id: nodeId,
    projectId,
    nodeId,
    text: '草稿正文',
    quotes: ['引用片段'],
    assets: [],
    updatedAt: NOW,
    ...patch,
  }
}

describe('ComposerDraftRepository', () => {
  let db: AppDatabase
  let repo: ReturnType<typeof createComposerDraftRepository>

  beforeEach(() => {
    db = new AppDatabase(`test-${Date.now()}-${Math.random()}`)
    repo = createComposerDraftRepository(db)
  })

  it('按 nodeId 存取草稿：主键即节点，跨节点互不干扰', async () => {
    await repo.save(makeDraft('n1', 'p1', { text: '节点一的草稿' }))
    await repo.save(makeDraft('n2', 'p1', { text: '节点二的草稿' }))

    expect((await repo.get('n1'))?.text).toBe('节点一的草稿')
    expect((await repo.get('n2'))?.text).toBe('节点二的草稿')
    expect(await repo.get('n3')).toBeUndefined()

    // 同一节点再存是整条覆盖，不会留下第二份
    await repo.save(makeDraft('n1', 'p1', { text: '改过的草稿', quotes: [] }))
    const reloaded = await repo.get('n1')
    expect(reloaded?.text).toBe('改过的草稿')
    expect(reloaded?.quotes).toEqual([])
    expect(await db.composerDrafts.count()).toBe(2)
  })

  it('待发图片的 Blob 完整往返', async () => {
    const asset = makeAsset('a1', 'p1', '图片字节')
    await repo.save(makeDraft('n1', 'p1', { assets: [asset] }))

    const loaded = await repo.get('n1')
    expect(loaded?.assets).toHaveLength(1)
    expect(loaded?.assets[0].id).toBe('a1')
    expect(await loaded!.assets[0].blob.text()).toBe('图片字节')
  })

  it('删除草稿与按项目清空', async () => {
    await repo.save(makeDraft('n1', 'p1'))
    await repo.save(makeDraft('n2', 'p1'))
    await repo.save(makeDraft('n3', 'p2'))

    await repo.remove('n1')
    expect(await repo.get('n1')).toBeUndefined()
    expect(await repo.get('n2')).toBeDefined()

    await repo.removeByProject('p1')
    expect(await repo.get('n2')).toBeUndefined()
    // 别的项目不受影响
    expect(await repo.get('n3')).toBeDefined()
  })

  // 项目删除走 purgeProjectRows 的事务，草稿必须跟着一起清 ——
  // 草稿里带着待发图片的 Blob，漏清就是实打实的孤儿数据。
  it('项目删除时草稿随之清空（与 purgeProjectRows 同一事务）', async () => {
    await repo.save(makeDraft('n1', 'p1'))
    await repo.save(makeDraft('n2', 'p1'))

    const { purgeProjectRows } = await import('../sync-local')
    await purgeProjectRows(db, 'p1')

    expect(await db.composerDrafts.count()).toBe(0)
  })

  it('isEmptyDraft 判定空草稿', () => {
    expect(isEmptyDraft({ text: '', quotes: [], assets: [] })).toBe(true)
    expect(isEmptyDraft({ text: ' ', quotes: [], assets: [] })).toBe(false)
    expect(isEmptyDraft({ text: '', quotes: ['x'], assets: [] })).toBe(false)
    expect(
      isEmptyDraft({ text: '', quotes: [], assets: [makeAsset('a1', 'p1', 'x')] }),
    ).toBe(false)
  })
})
