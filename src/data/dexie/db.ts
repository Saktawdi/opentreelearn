import Dexie, { type Table } from 'dexie'
import type {
  Asset,
  GlobalSettings,
  Id,
  Message,
  Node,
  Note,
  Project,
  ProjectSettings,
} from '@/domain/models'

export interface SettingsRecord {
  key: string
  value: GlobalSettings
}

export const SETTINGS_KEY = 'global'

export class AppDatabase extends Dexie {
  projects!: Table<Project, Id>
  projectSettings!: Table<ProjectSettings, Id>
  nodes!: Table<Node, Id>
  messages!: Table<Message, Id>
  assets!: Table<Asset, Id>
  notes!: Table<Note, Id>
  settings!: Table<SettingsRecord, string>

  constructor(name = 'opentreelearn') {
    super(name)

    this.version(1).stores({
      projects: 'id, updatedAt, *tags',
      projectSettings: 'projectId',
      nodes: 'id, projectId, parentId, [projectId+parentId]',
      messages: 'id, nodeId, projectId, [nodeId+createdAt]',
      assets: 'id, projectId',
      settings: 'key',
    })

    // v2 只加表，不改老表：Dexie 会把新声明合并进已有 schema，v1 的索引原样保留。
    // nodeId 与 messageId 都建索引 —— 删除节点/重试消息时都要按它们级联清笔记。
    this.version(2).stores({
      notes: 'id, projectId, nodeId, messageId',
    })
  }
}