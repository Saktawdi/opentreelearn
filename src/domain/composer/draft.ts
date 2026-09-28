import type { Asset, Id } from '@/domain/models'

/**
 * 对话输入框草稿。
 *
 * 用户打了一半字、切走页面又回来时，输入框要回到离开前的样子。这里存的是
 * 「还没发出去」的全部内容：正文、引用胶囊、待发图片。
 *
 * 两条设计约束：
 *
 * 1. **一个节点至多一份草稿**，所以主键直接用 nodeId，不另生成 id ——
 *    「按节点隔离」这条规则落在主键上，跨节点串台就不可能发生。
 * 2. **待发图片整份存在草稿里，不提前写进 assets 表**：图片只有随消息真正
 *    发出后才成为资产。草稿发出去时整条删除，assets 表里不会留下无人引用的孤儿。
 *
 * 草稿只存在本机，不参与云同步 —— 它是「当前这台设备上没说完的话」，
 * 换台设备接着说并不成立。
 */
export interface ComposerDraft {
  /** 主键即 nodeId */
  id: Id
  projectId: Id
  nodeId: Id
  text: string
  /** 引用胶囊的原文，按加入顺序排列 */
  quotes: string[]
  /** 待发图片：整份 Asset（含已压缩的 Blob），发送时才转存到 assets 表 */
  assets: Asset[]
  updatedAt: number
}

/** 草稿是否为空 —— 空的草稿不落盘，删掉即可，免得空壳记录堆满表。 */
export function isEmptyDraft(draft: Pick<ComposerDraft, 'text' | 'quotes' | 'assets'>): boolean {
  return draft.text.length === 0 && draft.quotes.length === 0 && draft.assets.length === 0
}
