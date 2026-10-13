import type { FreeAskRepository } from '../repository'
import type { AppDatabase } from './db'
import type { SyncLocal } from '../sync-local'

export function createFreeAskRepository(db: AppDatabase, sync: SyncLocal): FreeAskRepository {
  return {
    listByProject: async (projectId) =>
      (await db.freeAskConversations.where('projectId').equals(projectId).toArray())
        .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)),
    get: (id) => db.freeAskConversations.get(id),
    create: async (conversation) => {
      await db.transaction('rw', db.freeAskConversations, db.outbox, async () => {
        await db.freeAskConversations.add(conversation)
        await sync.recordChange('freeAskConversation', conversation.id, 'upsert')
      })
    },
    listMessages: (id) => db.freeAskMessages.where('conversationId').equals(id).sortBy('createdAt'),
    saveMessage: async (message) => {
      await db.transaction('rw', db.freeAskConversations, db.freeAskMessages, db.outbox, async () => {
        const conversation = await db.freeAskConversations.get(message.conversationId)
        if (!conversation || conversation.projectId !== message.projectId) return
        const previous = await db.freeAskMessages.get(message.id)
        const now = Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1, conversation.updatedAt + 1)
        await db.freeAskMessages.put({ ...message, updatedAt: now })
        await db.freeAskConversations.put({
          ...conversation, updatedAt: now,
          title: conversation.title || (message.role === 'user' ? message.text.replace(/\s+/g, ' ').trim().slice(0, 60) : ''),
        })
        await sync.recordChange('freeAskMessage', message.id, 'upsert')
        await sync.recordChange('freeAskConversation', conversation.id, 'upsert')
      })
    },
    getLocal: (id) => db.freeAskLocal.get(id),
    saveLocal: async (state) => { await db.freeAskLocal.put(state) },
  }
}
