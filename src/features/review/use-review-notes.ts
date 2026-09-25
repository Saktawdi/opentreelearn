import type { Id, Note } from '@/domain/models'
import { useWorkspaceStore } from '@/stores/workspace-store'

const EMPTY_NOTES: Note[] = []

/** 某条消息上的标注（与 workspace-store.notesByMessage 同一张表，按 messageId 取桶）。 */
export function useReviewMessageNotes(messageId: Id): Note[] {
  return useWorkspaceStore((state) => state.notesByMessage[messageId]) ?? EMPTY_NOTES
}
