import Dexie, { type Table } from 'dexie'
import type { Asset, GlobalSettings, Id, Message, Node, Project, ProjectSettings } from '@/domain/models'

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
  }
}