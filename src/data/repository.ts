import type {
  Asset,
  GlobalSettings,
  Id,
  Message,
  Node,
  Note,
  Project,
  ProjectSettings,
  ReviewGrade,
} from '@/domain/models'
import type { ReviewItemResult, ReviewSessionRecord } from '@/domain/review/session'

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

export interface GradeReviewInput {
  sessionId: Id
  itemId: Id
  /** 幂等键：第一次尝试前生成并落库，重试必须复用 */
  operationId: Id
  projectId: Id
  nodeId: Id
  grade: ReviewGrade
  /** 调用方看到的会话版本；小于库里的版本说明这次写入基于过期状态 */
  expectedVersion: number
  now: number
}

/**
 * 仓储层拒绝一次评分/撤销的原因。
 *
 * 这里只给**数据口径**，界面用 `t(\`session.refusal.${reason}\`)` 解析成当前语言。
 * 之前这一层直接返回中文 message —— 文案被写死在持久化层，英文界面下会显示中文，
 * 而且它落进会话记录跟着一起同步，等于把界面语言焊进了数据。
 */
export type ReviewRefusal =
  /** 会话记录已不存在（项目删除 / 账号切换 / 手动清理） */
  | 'sessionMissing'
  /** 这一项已不在本次会话中 */
  | 'itemMissing'
  /** 同一项已评分过：重试同一操作，或另一标签页先评了 */
  | 'alreadyGraded'
  /** 会话已结束 / 暂停，不再接受评分 */
  | 'sessionEnded'
  /** 当前项阶段对不上（保存被中断，或状态机走了别的分支） */
  | 'phaseChanged'
  /** 库里的版本比调用方预期新：另一个标签页刚写过 */
  | 'versionStale'
  /** 节点已删除 / 归档 */
  | 'nodeUnavailable'
  /** 节点已移出复习计划 */
  | 'unenrolled'
  /** 这一项没有可撤销的评分 */
  | 'nothingToUndo'
  /** 撤销时节点已被删除 */
  | 'nodeDeleted'
  /** 撤销时掌握度 / 排期已被别处改动，不能拿旧快照覆盖 */
  | 'recordChanged'

export type GradeReviewOutcome =
  /** 本次写入生效 */
  | { status: 'applied'; node: Node; session: ReviewSessionRecord; result: ReviewItemResult }
  /** 同一个操作（或同一项）已经落过库；**不重复写**，返回既有结果 */
  | { status: 'duplicate'; node: Node; session: ReviewSessionRecord; result: ReviewItemResult }
  /** 状态已变化（别处已评分 / 版本过期），需要刷新后重新确认 */
  | { status: 'conflict'; reason: ReviewRefusal; session: ReviewSessionRecord }
  /** 会话记录已不存在（被项目删除、账号切换或手动清理） */
  | { status: 'missing'; reason: ReviewRefusal }
  /** 节点已删除 / 归档 / 移出计划：当前项转 unavailable，不评分 */
  | { status: 'unavailable'; reason: ReviewRefusal; session: ReviewSessionRecord }

export interface UndoReviewInput {
  sessionId: Id
  itemId: Id
  projectId: Id
  nodeId: Id
  now: number
}

export type UndoReviewOutcome =
  | { status: 'applied'; node: Node; session: ReviewSessionRecord }
  | { status: 'conflict'; reason: ReviewRefusal; session: ReviewSessionRecord }
  | { status: 'missing'; reason: ReviewRefusal; session?: ReviewSessionRecord }

/**
 * 复习会话仓储。
 *
 * 评分与撤销必须是**一个事务**：节点（掌握度 + 排期）、同步台账与会话记录要么一起
 * 成功要么一起回滚。旧实现里 `nodes.update` 单独调用、会话只在内存里，
 * 刷新一次就丢，重试还会把一次复习算成两次。
 */
export interface ReviewSessionRepository {
  get(id: Id): Promise<ReviewSessionRecord | undefined>
  /** 项目里未完成的会话（active / paused）；每个项目至多一份 */
  findOpen(projectId: Id): Promise<ReviewSessionRecord | undefined>
  /** 项目内全部会话（含已完成 / 已结束），按更新时间倒序 */
  listByProject(projectId: Id): Promise<ReviewSessionRecord[]>
  /**
   * 落库整条会话。
   * 同一项目已存在**另一份**未完成会话时拒绝写入（返回既有会话）——「每个项目
   * 至多一份未完成会话」的约束必须落在持久化层，不能只靠按钮禁用。
   */
  save(session: ReviewSessionRecord): Promise<ReviewSessionRecord>
  remove(id: Id): Promise<void>
  removeByProject(projectId: Id): Promise<void>
  grade(input: GradeReviewInput): Promise<GradeReviewOutcome>
  undo(input: UndoReviewInput): Promise<UndoReviewOutcome>
}

export interface Repositories {
  projects: ProjectRepository
  projectSettings: ProjectSettingsRepository
  nodes: NodeRepository
  messages: MessageRepository
  assets: AssetRepository
  notes: NoteRepository
  settings: SettingsRepository
  reviewSessions: ReviewSessionRepository
}