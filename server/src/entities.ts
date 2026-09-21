/**
 * 参与同步的实体名。客户端每条记录都带 `entity`，服务端不解释载荷内容，
 * 只用它做（账号 + 实体 + 客户端 id）的唯一键，因此这里的值必须与客户端一致。
 */
export const SYNC_ENTITIES = [
  'project',
  'projectSettings',
  'node',
  'message',
  'note',
  'globalSettings',
  'asset',
] as const

export type SyncEntity = (typeof SYNC_ENTITIES)[number]