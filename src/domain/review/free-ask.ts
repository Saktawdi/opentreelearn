import type { Asset, Id } from '@/domain/models'
import { z } from 'zod'

export const freeAskConversationSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), title: z.string(),
  createdAt: z.number().finite().nonnegative(), updatedAt: z.number().finite().nonnegative(),
})
export const freeAskMessageSchema = z.object({
  id: z.string().min(1), conversationId: z.string().min(1), projectId: z.string().min(1),
  role: z.enum(['user', 'assistant']), text: z.string(),
  createdAt: z.number().finite().nonnegative(), updatedAt: z.number().finite().nonnegative(),
  incomplete: z.boolean().optional(), imageIds: z.array(z.string()).optional(),
})

/** Free Q&A has its own conversations; learning threads and graded reviews stay separate. */
export interface FreeAskConversation {
  id: Id
  projectId: Id
  title: string
  createdAt: number
  updatedAt: number
}

export interface FreeAskMessage {
  id: Id
  conversationId: Id
  projectId: Id
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  updatedAt: number
  incomplete?: boolean
  imageIds?: Id[]
}

/** Selection and unsent drafts stay on this browser, in the same account database. */
export interface FreeAskLocalState {
  id: Id
  projectId: Id
  activeConversationId?: Id
  draft?: string
  pendingImages?: Asset[]
}
