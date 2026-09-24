import { Pencil } from 'lucide-react'
import { memo, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import type { Id, Note, NoteLabel } from '@/domain/models'
import { collectUsedLabels, formatNoteLabels, noteLabelName } from '@/domain/notes'
import { normalizeWhitespace } from '@/lib/text'
import { cn, errorMessage } from '@/lib/utils'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { NoteDialog } from './NoteDialog'
import { revealNote } from './note-anchor'

/**
 * 标注条里的单行预览。
 *
 * quote 存的是**源文**（公式连同 `$…$` 一起，见 note-anchor.ts），一行里塞 `$` 只会更挤；
 * 展示时把公式定界符收掉，里面的 LaTeX 仍照原样 —— 这是预览，不是可以复制的正文。
 */
function quotePreview(quote: string): string {
  return normalizeWhitespace(quote.replace(/\$\$?/g, ''))
}

/**
 * 消息下方的标注条：这条消息上的高亮与带标签的标注都在这里回看。
 *
 * 正文里的标记只画出「哪一段被标了」，标签、序号与备注放这里 —— 正文是 Markdown 渲染的，
 * 不能往里插节点（见 note-anchor.ts），序号就成了两者的桥：正文不编号，靠点击定位。
 *
 * 带标签的标注显示标签名；纯高亮只显示序号与原文 —— 后者是用户自己的书签，
 * 不参与 AI 上下文，界面上也不该长得像「重要结论」。
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

  // 始终从最新列表里取：标注被删掉时弹窗会自己消失，不会编辑一条已经不存在的记录
  const editing = editingId ? (notes.find((note) => note.id === editingId) ?? null) : null

  if (notes.length === 0) return null

  const save = async (note: Note, input: { labels: NoteLabel[]; body?: string }) => {
    try {
      await updateNote(note.id, {
        labels: input.labels,
        ...(input.body !== undefined ? { body: input.body } : {}),
      })
      setEditingId(null)
    } catch (error) {
      toast.error(`保存标注失败：${errorMessage(error)}`)
    }
  }

  const drop = async (note: Note) => {
    try {
      await removeNote(note.id)
      setEditingId(null)
      toast.success(note.labels.length > 0 ? `已删除标注 ${formatNoteLabels(note.labels)}` : '已删除高亮')
    } catch (error) {
      toast.error(`删除标注失败：${errorMessage(error)}`)
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
                  note.labels.length > 0
                    ? 'bg-info/20 text-info'
                    : 'bg-accent/20 text-accent',
                )}
              >
                {index + 1}
              </span>
              {note.labels.map((label) => (
                <Badge key={label} tone="accent" className="shrink-0">
                  {noteLabelName(label)}
                </Badge>
              ))}
              <span className="max-w-[240px] truncate">{quotePreview(note.quote)}</span>
              {note.body ? (
                <span className="max-w-[200px] truncate text-muted">
                  · {normalizeWhitespace(note.body)}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              aria-label={
                note.labels.length > 0
                  ? `编辑标注 ${formatNoteLabels(note.labels)}`
                  : '编辑高亮'
              }
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
          quote={editing.quote}
          labels={editing.labels}
          body={editing.body}
          suggestions={collectUsedLabels(notes)}
          onCancel={() => setEditingId(null)}
          onSubmit={(input) => save(editing, input)}
          onDelete={() => void drop(editing)}
        />
      ) : null}
    </>
  )
})