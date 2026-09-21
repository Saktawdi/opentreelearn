import { Pencil } from 'lucide-react'
import { memo, useState } from 'react'
import { toast } from 'sonner'
import type { Id, Note } from '@/domain/models'
import { noteKindLabel } from '@/domain/notes'
import { normalizeWhitespace } from '@/lib/text'
import { cn, errorMessage } from '@/lib/utils'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { NoteDialog } from './NoteDialog'
import { revealNote } from './note-anchor'

/**
 * 消息下方的笔记条：这条消息上的高亮与批注都在这里回看。
 *
 * 正文里的高亮只画出「哪一段被标了」，序号与批注正文放这里 —— 正文是 Markdown 渲染的，
 * 不能往里插节点（见 note-anchor.ts），序号就成了两者的桥：正文不编号，靠点击定位。
 */
export const MessageNotes = memo(function MessageNotes({
  notes,
  align = 'start',
}: {
  notes: Note[]
  align?: 'start' | 'end'
}) {
  const updateNote = useWorkspaceStore((state) => state.updateNote)
  const removeNote = useWorkspaceStore((state) => state.removeNote)
  const [editingId, setEditingId] = useState<Id | null>(null)

  // 始终从最新列表里取：笔记被删掉时弹窗会自己消失，不会编辑一条已经不存在的记录
  const editing = editingId ? (notes.find((note) => note.id === editingId) ?? null) : null

  if (notes.length === 0) return null

  const save = async (note: Note, body: string) => {
    try {
      await updateNote(note.id, { body })
      setEditingId(null)
    } catch (error) {
      toast.error(`保存笔记失败：${errorMessage(error)}`)
    }
  }

  const drop = async (note: Note) => {
    try {
      await removeNote(note.id)
      setEditingId(null)
      toast.success(`已删除${noteKindLabel(note.kind)}`)
    } catch (error) {
      toast.error(`删除笔记失败：${errorMessage(error)}`)
    }
  }

  return (
    <>
      <div
        className={cn(
          'flex max-w-full flex-wrap gap-1.5 pt-0.5',
          align === 'end' ? 'justify-end' : 'justify-start',
        )}
      >
        {notes.map((note, index) => (
          <span
            key={note.id}
            className="group/note inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-line/70 bg-elevated/50 py-0.5 pl-1 pr-1 text-2xs"
          >
            <button
              type="button"
              onClick={() => revealNote(note)}
              title="定位到正文里的这段文字"
              className="inline-flex min-w-0 items-center gap-1.5 text-ink-soft transition-colors hover:text-accent"
            >
              <span
                className={cn(
                  'grid h-4 w-4 shrink-0 place-items-center rounded-full text-2xs font-medium',
                  note.kind === 'highlight'
                    ? 'bg-accent/20 text-accent'
                    : 'bg-info/20 text-info',
                )}
              >
                {index + 1}
              </span>
              <span className="max-w-[240px] truncate">{normalizeWhitespace(note.quote)}</span>
              {note.body ? (
                <span className="max-w-[200px] truncate text-muted">
                  · {normalizeWhitespace(note.body)}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              aria-label={`编辑${noteKindLabel(note.kind)}笔记`}
              onClick={() => setEditingId(note.id)}
              className="shrink-0 rounded-full p-0.5 text-faint opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/note:opacity-100"
            >
              <Pencil className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>

      {editing ? (
        <NoteDialog
          key={editing.id}
          kind={editing.kind}
          quote={editing.quote}
          body={editing.body}
          onCancel={() => setEditingId(null)}
          onSubmit={(body) => save(editing, body)}
          onDelete={() => void drop(editing)}
        />
      ) : null}
    </>
  )
})
