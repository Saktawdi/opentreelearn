import type { Id, Message, Node } from '@/domain/models'

let counter = 0

export function resetFixtureCounter(): void {
  counter = 0
}

export function makeNode(partial: Partial<Node> & { id: Id }): Node {
  counter += 1
  return {
    projectId: 'p1',
    parentId: null,
    forkFrom: null,
    title: partial.id,
    position: null,
    status: 'active',
    createdAt: counter,
    updatedAt: counter,
    ...partial,
  }
}

export function makeMessage(partial: Partial<Message> & { id: Id; nodeId: Id }): Message {
  counter += 1
  return {
    projectId: 'p1',
    role: 'user',
    parts: [{ type: 'text', text: partial.id }],
    createdAt: counter,
    ...partial,
  }
}

export function longText(prefix: string, length: number): string {
  return `${prefix}${'学'.repeat(length)}`
}

/**
 * 线性对话 u1 a1 u2 a2 …：消息 id 与角色固定，版本测试里按名字引用最省事。
 * 首条用户消息 id 从 `u1` 起。
 */
export function linearMessages(rounds: number, nodeId = 'n1'): Message[] {
  const messages: Message[] = []
  for (let i = 1; i <= rounds; i += 1) {
    messages.push(
      makeMessage({ id: `u${i}`, nodeId, role: 'user', createdAt: i * 2 - 1 }),
      makeMessage({ id: `a${i}`, nodeId, role: 'assistant', createdAt: i * 2 }),
    )
  }
  return messages
}

export function messagesByNode(entries: Array<[Id, Message[]]>): Map<Id, Message[]> {
  return new Map(entries)
}