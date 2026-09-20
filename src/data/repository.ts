import type {
  Asset,
  GlobalSettings,
  Id,
  Message,
  Node,
  Project,
  ProjectSettings,
} from '@/domain/models'

export interface ProjectRepository {
  list(): Promise<Project[]>
  get(id: Id): Promise<Project | undefined>
  create(project: Project): Promise<void>
  update(id: Id, patch: Partial<Project>): Promise<void>
  remove(id: Id): Promise<void>
}

export interface ProjectSettingsRepository {
  get(projectId: Id): Promise<ProjectSettings | undefined>
  save(settings: ProjectSettings): Promise<void>
  remove(projectId: Id): Promise<void>
}

export interface NodeRepository {
  listByProject(projectId: Id): Promise<Node[]>
  get(id: Id): Promise<Node | undefined>
  create(node: Node): Promise<void>
  createMany(nodes: Node[]): Promise<void>
  update(id: Id, patch: Partial<Node>): Promise<void>
  remove(id: Id): Promise<void>
  removeByProject(projectId: Id): Promise<void>
}

export interface MessageRepository {
  listByNode(nodeId: Id): Promise<Message[]>
  listByProject(projectId: Id): Promise<Message[]>
  get(id: Id): Promise<Message | undefined>
  create(message: Message): Promise<void>
  createMany(messages: Message[]): Promise<void>
  update(id: Id, patch: Partial<Message>): Promise<void>
  remove(id: Id): Promise<void>
  removeByProject(projectId: Id): Promise<void>
}

export interface AssetRepository {
  get(id: Id): Promise<Asset | undefined>
  listByProject(projectId: Id): Promise<Asset[]>
  create(asset: Asset): Promise<void>
  remove(id: Id): Promise<void>
  removeByProject(projectId: Id): Promise<void>
}

export interface SettingsRepository {
  load(): Promise<GlobalSettings>
  save(settings: GlobalSettings): Promise<void>
}

export interface Repositories {
  projects: ProjectRepository
  projectSettings: ProjectSettingsRepository
  nodes: NodeRepository
  messages: MessageRepository
  assets: AssetRepository
  settings: SettingsRepository
}