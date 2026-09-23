import type {
  AssessmentMeta,
  Message,
  Node,
  Note,
  Project,
  ReviewEnrollment,
} from '@/domain/models'
import { messageText } from '@/domain/messages'
import { stripReviewRating } from '@/domain/review/protocol'
import { resolveThread } from '@/domain/thread/resolve'
import { buildTreeIndex, depthOf } from '@/domain/tree/tree'

/**
 * 导出格式版本。
 *
 * - v1：只有卡片标题、显示路径对话、掌握度分数与复习中心标记；
 * - v2：补上**事实性**复习数据（掌握度快照时间、最近评分时间、计划开关、评估来源）、
 *   分支来源 `forkFrom`、画布坐标、卡片时间（`createdAt` / `updatedAt`）、归档标记与笔记。
 *
 * 排期（`review.card`）与复习会话仍然不导出：`due` 是绝对时间，跨设备/跨时区导入必然
 * 失真；会话是「本机、按账号」的练习记录，不是学习树的一部分。新增字段对只认 v1 的
 * 解析器是忽略即兼容（老端按缺省语义处理）。
 */
export const TREE_EXPORT_VERSION = 2

export interface RawTreeExportMessage {
  id: string
  role: 'user' | 'ai'
  content: string
  messageType?: string
  timestamp: number
  context?: string[]
  turnTitle?: string
  /**
   * 该消息里有几张图片。
   *
   * 图片本体在资产表里（二进制），不随 `.tree` 走；写上张数是为了让导入端能如实
   * 告诉用户「有几张图没跟过来」，而不是让纯图片消息悄悄变成空消息被丢掉。
   */
  images?: number
}

export interface RawTreeExportFork {
  /** 源节点 id（导入时会重映射） */
  nodeId: string
  /** 从源节点的哪条消息分出来的（导入时会重映射） */
  messageId: string
}

export interface RawTreeExportCard {
  id: string
  title: string
  messages: RawTreeExportMessage[]
  children: string[]
  depth?: number
  /**
   * 节点创建 / 最后更新时间。
   *
   * 导出它是因为**时间就是排布**：画布的树布局按 `createdAt` 排列根节点与同级节点，
   * 导入端要是自己按数组顺序合成时间，整棵树在画布上的左右次序就变了 —— 节点没丢，
   * 却「跑到别处去了」，看起来就像少了一棵树。
   */
  createdAt?: number
  updatedAt?: number
  position?: [number, number, number]
  /** 归档节点；普通节点不写这个字段（老工具忽略它，仍按活跃卡片读） */
  archived?: true
  /** 复习中心标记；普通学习节点不写这个字段 */
  kind?: 'review'
  /** 掌握度：分数、薄弱点、快照时间与最近评分时间（排期不导出，见文件头注释） */
  mastery?: {
    score: number
    weakPoints?: string[]
    updatedAt?: number
    gradedAt?: number
  }
  /** 复习计划开关；缺省 = 老文件，导入端按「缺省未加入」保守处理 */
  reviewEnrollment?: ReviewEnrollment
  /** 评估依据：哪次评估、依据哪次学习、来自 AI 还是复习评分 */
  assessmentMeta?: AssessmentMeta
  /** 分支来源：这个节点是从哪个节点的哪条消息分出来的 */
  forkFrom?: RawTreeExportFork
}

export interface RawTreeExportNote {
  id: string
  /** 锚定的消息 id（导入时重映射；映射不上就整条丢弃，不留下悬空批注） */
  messageId: string
  /**
   * 渲染形态标记。
   *
   * 新版本内部已没有 `kind` 概念（标签 + 备注就够表达），但**导出仍然写它**：
   * 老客户端与外部工具按它决定「画淡底还是加下划线」，不写会让它们把带标签的标注
   * 一律显示成纯高亮。取值由备注推出：有备注 = `annotation`，否则 `highlight`。
   */
  kind: string
  /**
   * 标注标签（v2 可选新增字段）。
   *
   * 加字段不升版本：只认 v1/v2 旧解析端会忽略它，那条标注退化成「无标签高亮」——
   * 用户仍看得见划线，只是标签没显示。反向（新端读老文件）由 `kind` 兜底。
   */
  labels?: string[]
  quote: string
  start: number
  end: number
  body?: string
  createdAt: number
  updatedAt: number
}

export interface RawTreeExportProject {
  type: 'project'
  version: number
  data: {
    id: string
    name: string
    cards: RawTreeExportCard[]
    notes?: RawTreeExportNote[]
    createdAt: number
    updatedAt: number
  }
}

/**
 * 将 Project、Node 列表、Message 列表与笔记转换成标准 .tree 项目 JSON 结构。
 *
 * **有损之处都明说**：节点内的历史版本只导出当前显示路径（`.tree` 没有版本概念）；
 * 图片本体不随文件走，只写张数；`forkFrom` 只保留「哪个节点的哪条消息」这一层，
 * 冻结的版号快照 `selection` 不导出（它指向的消息 id 在导入时全部重编号）。
 */
export function buildTreeExportData(
  project: Project,
  nodes: Node[],
  messages: Message[],
  notes: Note[] = [],
): RawTreeExportProject {
  // 归档节点也导出（写 `archived: true`）：静默丢掉一整棵子树，比让外部工具看到它更糟
  const index = buildTreeIndex(nodes)

  // 消息按 nodeId 分组，且按时间排序
  const messagesByNode = new Map<string, Message[]>()
  for (const msg of messages) {
    const list = messagesByNode.get(msg.nodeId)
    if (list) list.push(msg)
    else messagesByNode.set(msg.nodeId, [msg])
  }
  for (const list of messagesByNode.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt)
  }

  // 映射 cards
  const exportedMessageIds = new Set<string>()
  const cards: RawTreeExportCard[] = nodes.map((node) => {
    // .tree 没有版本概念：只导出显示路径（有损导出，历史版本留在应用里）
    const nodeMsgs = resolveThread(node, messagesByNode.get(node.id) ?? []).path
    const depth = depthOf(index, node.id)
    const childIds = (index.children.get(node.id) ?? []).map((child) => child.id)

    const mappedMessages: RawTreeExportMessage[] = nodeMsgs.map((msg) => {
      exportedMessageIds.add(msg.id)
      // 评分标记是应用内协议，导出给别的工具读时剥掉
      const text = stripReviewRating(messageText(msg))
      const isUser = msg.role === 'user'
      const role: 'user' | 'ai' = isUser ? 'user' : 'ai'
      const images = msg.parts.filter((part) => part.type === 'image').length

      const rawMsg: RawTreeExportMessage = {
        id: msg.id,
        role,
        content: text,
        messageType: 'text',
        timestamp: msg.createdAt,
      }

      if (images > 0) rawMsg.images = images

      // 如果节点存有 contextSeed，并且是第一条 user 消息，附带 context 保证 round-trip 完美还原
      if (isUser && node.contextSeed && node.contextSeed.length > 0) {
        rawMsg.context = node.contextSeed
      }

      return rawMsg
    })

    const card: RawTreeExportCard = {
      id: node.id,
      title: node.title,
      messages: mappedMessages,
      children: childIds,
      depth,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    }

    if (node.position) {
      card.position = [node.position.x, node.position.y, 0]
    }

    if (node.status === 'archived') card.archived = true

    if (node.kind === 'review') {
      card.kind = 'review'
    }

    if (node.mastery) {
      card.mastery = {
        score: node.mastery.score,
        ...(node.mastery.weakPoints ? { weakPoints: node.mastery.weakPoints } : {}),
        updatedAt: node.mastery.updatedAt,
        ...(node.mastery.gradedAt !== undefined ? { gradedAt: node.mastery.gradedAt } : {}),
      }
    }

    if (node.reviewEnrollment) card.reviewEnrollment = node.reviewEnrollment
    if (node.assessmentMeta) card.assessmentMeta = node.assessmentMeta

    if (node.forkFrom) {
      card.forkFrom = { nodeId: node.forkFrom.nodeId, messageId: node.forkFrom.messageId }
    }

    return card
  })

  // 标注：只带锚在导出消息上的（挂在被裁掉的历史版本上的标注没有落点）
  const mappedNotes: RawTreeExportNote[] = notes
    .filter((note) => exportedMessageIds.has(note.messageId))
    .map((note) => ({
      id: note.id,
      messageId: note.messageId,
      // 老读者的兼容字段：由备注推出渲染形态（标签是新增的可选字段）
      kind: note.body ? 'annotation' : 'highlight',
      ...(note.labels.length > 0 ? { labels: note.labels } : {}),
      quote: note.quote,
      start: note.start,
      end: note.end,
      ...(note.body ? { body: note.body } : {}),
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    }))

  return {
    type: 'project',
    version: TREE_EXPORT_VERSION,
    data: {
      id: project.id,
      name: project.name,
      cards,
      ...(mappedNotes.length > 0 ? { notes: mappedNotes } : {}),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
  }
}

/**
 * 格式化输出为 .tree JSON 字符串
 */
export function stringifyTreeExport(exportData: RawTreeExportProject): string {
  return JSON.stringify(exportData, null, 2)
}

/**
 * 触发浏览器文件下载
 */
export function downloadFile(content: string, filename: string, mimeType = 'application/json;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}