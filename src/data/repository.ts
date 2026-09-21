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
  /** 全项目读出节点：首页「今日复习」要跨项目统计到期数。 */
  listAll(): Promise<Node[]>
  get(id: Id): Promise<Node | undefined>
  create(node: Node): Promise<void>
  createMany(nodes: Node[]): Promise<void>
  /**
   * 改一条节点。**所有节点写入都必须走这里**：直接 `db.nodes.update` 会绕过
   * outbox 记账，改动就同步不出去（掌握度 / 复习排期全在节点载荷里）。
   */
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

export interface NoteRepository {
  listByProject(projectId: Id): Promise<Note[]>
  /** 写入即整条覆盖（`put`）：批注被清空时要把 body 键真正去掉。 */
  create(note: Note): Promise<void>
  remove(id: Id): Promise<void>
  remove(id: Id): Promise<void>
  /** 节点（含子树）被删除时清理其下所有消息的笔记。 */
  removeByNode(nodeId: Id): Promise<void>
  /** 单条消息被重试/删除时清理它的笔记。 */
  removeByMessage(messageId: Id): Promise<void>
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
  notes: NoteRepository
  settings: SettingsRepository
}