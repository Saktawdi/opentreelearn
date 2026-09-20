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

export function messagesByNode(entries: Array<[Id, Message[]]>): Map<Id, Message[]> {
  return new Map(entries)
}