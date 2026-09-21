import type { Message, Node, Project } from '@/domain/models'
import { messageText } from '@/domain/messages'
import { resolveThread } from '@/domain/thread/resolve'
import { buildTreeIndex, depthOf } from '@/domain/tree/tree'

export interface RawTreeExportMessage {
  id: string
  role: 'user' | 'ai'
  content: string
  messageType?: string
  timestamp: number
  context?: string[]
  turnTitle?: string
}

export interface RawTreeExportCard {
  id: string
  title: string
  messages: RawTreeExportMessage[]
  children: string[]
  depth?: number
  position?: [number, number, number]
}

export interface RawTreeExportProject {
  type: 'project'
  version: number
  data: {
    id: string
    name: string
    cards: RawTreeExportCard[]
    createdAt: number
    updatedAt: number
  }
}

/**
 * 将 Project、Node 列表和 Message 列表转换成标准 .tree 项目 JSON 结构
 */
export function buildTreeExportData(
  project: Project,
  nodes: Node[],
  messages: Message[],
): RawTreeExportProject {
  // 只导出 active 状态的节点（或者所有节点，默认保持完整结构）
  const activeOnly = nodes.filter((n) => n.status !== 'archived')
  const index = buildTreeIndex(activeOnly)

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
  const cards: RawTreeExportCard[] = activeOnly.map((node) => {
    // .tree 没有版本概念：只导出显示路径（有损导出，历史版本留在应用里）
    const nodeMsgs = resolveThread(node, messagesByNode.get(node.id) ?? []).path
    const depth = depthOf(index, node.id)
    const childIds = (index.children.get(node.id) ?? []).map((child) => child.id)

    const mappedMessages: RawTreeExportMessage[] = nodeMsgs.map((msg) => {
      const text = messageText(msg)
      const isUser = msg.role === 'user'
      const role: 'user' | 'ai' = isUser ? 'user' : 'ai'

      const rawMsg: RawTreeExportMessage = {
        id: msg.id,
        role,
        content: text,
        messageType: 'text',
        timestamp: msg.createdAt,
      }

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
    }

    if (node.position) {
      card.position = [node.position.x, node.position.y, 0]
    }

    return card
  })

  return {
    type: 'project',
    version: 1,
    data: {
      id: project.id,
      name: project.name,
      cards,
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
