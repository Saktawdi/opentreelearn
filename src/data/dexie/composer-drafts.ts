import type { ComposerDraftRepository } from '../repository'
import { normalizeComposerDraft } from '@/domain/normalize'
import type { AppDatabase } from './db'

/**
 * 输入框草稿走本机 IndexedDB，不进同步台账。
 *
 * 与 `assets` 表一样是「本机数据」定位，但两者生命周期相反：图片是**发出后**
 * 才成为资产，草稿里的图片则随草稿一起删。assets 表已经因为对象存储未落地
 * 而不同步，草稿再加一份同步只会把没发出去的内容推上云，没有对应收益。
 */
export function createComposerDraftRepository(db: AppDatabase): ComposerDraftRepository {
  return {
    get: async (nodeId) => {
      const row = await db.composerDrafts.get(nodeId)
      // 读回边界归一化：草稿字段缺失不该让输入框整个不可用
      return row ? (normalizeComposerDraft(row) ?? undefined) : undefined
    },
    save: async (draft) => {
      await db.composerDrafts.put(draft)
    },
    remove: async (nodeId) => {
      await db.composerDrafts.delete(nodeId)
    },
    removeByProject: async (projectId) => {
      await db.composerDrafts.where('projectId').equals(projectId).delete()
    },
  }
}
