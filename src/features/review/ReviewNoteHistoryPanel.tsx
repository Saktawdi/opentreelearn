import { Pencil, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { Id, Note, Node } from '@/domain/models'
import { formatNoteLabels, noteOrigin } from '@/domain/notes'
import type { ReviewSessionRecord } from '@/domain/review/session'
import { cn, errorMessage } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/time'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { NoteDialog } from '@/features/chat/NoteDialog'
import { quotePreview } from '@/features/chat/note-preview'

type HistoryScope = 'current' | 'session'

interface ReviewNoteHistoryPanelProps {
  session: ReviewSessionRecord | null
  /** 当前练习的主题；scope=current 时只看它 */
  currentNodeId?: Id
  nodes: Node[]
  onClose: () => void
  /** 点击条目的定位动作（面板不知道内容此刻渲染在哪，交给工作区决定） */
  onReveal: (note: Note) => void
}

/**
 * 笔记历史面板：本主题（或本次复习全部主题）的「学习期标注 + 复习期标记」聚合回看。
 *
 * 数据只从 workspace-store.notesByMessage 一张表来 —— 复习期标注与学习期标注同库同构，
 * 靠 `origin` 区分创建面（这正是投喂策略与分组展示的依据），不需要任何额外索引。
 * 点击条目把原文滚进视野并闪烁；编辑 / 删除复用标注弹窗，与学习对话同一套交互。
 */
export function ReviewNoteHistoryPanel({
  session,
  currentNodeId,
  nodes,
  onClose,
  onReveal,
}: ReviewNoteHistoryPanelProps) {
  const { t } = useTranslation('review')
  const notesByMessage = useWorkspaceStore((state) => state.notesByMessage)
  const updateNote = useWorkspaceStore((state) => state.updateNote)
  const removeNote = useWorkspaceStore((state) => state.removeNote)

  const [scope, setScope] = useState<HistoryScope>('current')
  const [editingId, setEditingId] = useState<Id | null>(null)

  const titleOf = useMemo(() => {
    const map = new Map<Id, string>(nodes.map((node) => [node.id, node.title]))
    return (nodeId: Id) => map.get(nodeId) ?? t('notes.nodeDeleted')
  }, [nodes, t])

  const scopeNodeIds = useMemo(() => {
    if (scope === 'current') return new Set(currentNodeId ? [currentNodeId] : [])
    return new Set((session?.items ?? []).map((item) => item.nodeId))
  }, [scope, currentNodeId, session])

  const { chatNotes, reviewNotes } = useMemo(() => {
    const chat: Note[] = []
    const review: Note[] = []
    for (const bucket of Object.values(notesByMessage)) {
      for (const note of bucket) {
        if (!scopeNodeIds.has(note.nodeId)) continue
        ;(noteOrigin(note) === 'review' ? review : chat).push(note)
      }
    }
    const byTime = (a: Note, b: Note) => b.createdAt - a.createdAt
    return { chatNotes: chat.sort(byTime), reviewNotes: review.sort(byTime) }
  }, [notesByMessage, scopeNodeIds])

  // 始终从最新列表里取：标注被删掉时弹窗自己消失，不会编辑一条已不存在的记录
  const allNotes = useMemo(() => [...chatNotes, ...reviewNotes], [chatNotes, reviewNotes])
  const editing = editingId ? (allNotes.find((note) => note.id === editingId) ?? null) : null

  const saveEdit = async (note: Note, input: { labels: Note['labels']; body?: string }) => {
    try {
      await updateNote(note.id, {
        labels: input.labels,
        ...(input.body !== undefined ? { body: input.body } : {}),
      })
      setEditingId(null)
    } catch (error) {
      toast.error(t('notes.toastSaveFailed', { error: errorMessage(error) }))
    }
  }

  const drop = async (note: Note) => {
    try {
      await removeNote(note.id)
      setEditingId(null)
      toast.success(
        note.labels.length > 0
          ? t('notes.toastDeletedLabels', { labels: formatNoteLabels(note.labels) })
          : t('notes.toastDeletedHighlight'),
      )
    } catch (error) {
      toast.error(t('notes.toastDeleteFailed', { error: errorMessage(error) }))
    }
  }

  const showScopeToggle = (session?.items.length ?? 0) > 1

  return (
    <aside
      role="region"
      aria-label={t('notes.panelAria')}
      className="flex h-full w-full flex-col border-l border-line/60 bg-surface/95 backdrop-blur-md"
    >
      {/* 头部 */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-line/60 px-4">
        <div className="flex items-center gap-2">
          <Pencil className="h-4 w-4 text-accent" />
          <span className="text-xs font-medium text-ink">{t('notes.title')}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('notes.close')}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 范围切换 */}
      {showScopeToggle ? (
        <div className="flex shrink-0 border-b border-line/60 px-4 pt-2">
          <button
            type="button"
            onClick={() => setScope('current')}
            className={`border-b-2 px-3 py-1.5 text-xs font-medium transition-colors ${
              scope === 'current'
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {t('notes.scopeCurrent')}
          </button>
          <button
            type="button"
            onClick={() => setScope('session')}
            className={`border-b-2 px-3 py-1.5 text-xs font-medium transition-colors ${
              scope === 'session'
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {t('notes.scopeSession')}
          </button>
        </div>
      ) : null}

      <div className="border-b border-line/60 px-4 py-2 text-2xs text-faint">
        {t('notes.hint')}
      </div>

      {/* 分组列表 */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <NoteGroup
          title={t('notes.chatGroupTitle', { count: chatNotes.length })}
          hint={t('notes.chatGroupHint')}
          notes={chatNotes}
          emptyText={t('notes.chatEmpty')}
          showNodeTitle={scope === 'session'}
          titleOf={titleOf}
          onReveal={onReveal}
          onEdit={setEditingId}
        />
        <NoteGroup
          title={t('notes.reviewGroupTitle', { count: reviewNotes.length })}
          hint={t('notes.reviewGroupHint')}
          notes={reviewNotes}
          emptyText={t('notes.reviewEmpty')}
          showNodeTitle={scope === 'session'}
          titleOf={titleOf}
          onReveal={onReveal}
          onEdit={setEditingId}
        />
      </div>

      {editing ? (
        <NoteDialog
          key={editing.id}
          quote={editing.quote}
          labels={editing.labels}
          body={editing.body}
          suggestions={[]}
          onCancel={() => setEditingId(null)}
          onSubmit={(input) => void saveEdit(editing, input)}
          onDelete={() => void drop(editing)}
        />
      ) : null}
    </aside>
  )
}

function NoteGroup({
  title,
  hint,
  notes,
  emptyText,
  showNodeTitle,
  titleOf,
  onReveal,
  onEdit,
}: {
  title: string
  hint: string
  notes: Note[]
  emptyText: string
  showNodeTitle: boolean
  titleOf: (nodeId: Id) => string
  onReveal: (note: Note) => void
  onEdit: (id: Id) => void
}) {
  const { t } = useTranslation('review')
  return (
    <section className="mb-5 last:mb-0">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h3 className="text-2xs font-semibold text-ink">{title}</h3>
        <span className="text-2xs text-faint">{hint}</span>
      </div>
      {notes.length === 0 ? (
        <p className="rounded-md border border-dashed border-line/60 px-3 py-3 text-center text-2xs text-faint">
          {emptyText}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {notes.map((note) => (
            <li
              key={note.id}
              className="group/note-row rounded-md border border-line/60 bg-elevated/40 px-2.5 py-2 transition-colors hover:border-line-strong"
            >
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  onClick={() => onReveal(note)}
                  title={t('notes.revealTitle')}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex flex-wrap items-center gap-1">
                    {note.labels.length > 0 ? (
                      note.labels.map((label) => (
                        <Badge key={label} tone="accent" className="shrink-0">
                          {t(`common:noteLabel.${label}`)}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-2xs text-faint">{t('notes.highlight')}</span>
                    )}
                    <span className="text-2xs text-faint">{formatRelativeTime(note.createdAt)}</span>
                    {showNodeTitle ? (
                      <span className="truncate text-2xs text-muted">· {titleOf(note.nodeId)}</span>
                    ) : null}
                  </div>
                  {/* 原文与备注都给人看；「复习期标注不送原文」只针对 AI 投喂口径 */}
                  <p className="mt-1 truncate text-xs text-ink-soft">{quotePreview(note.quote)}</p>
                  {note.body ? (
                    <p className="mt-0.5 truncate text-2xs text-muted">· {note.body}</p>
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-label={t('notes.editAria')}
                  onClick={() => onEdit(note.id)}
                  className={cn(
                    'shrink-0 rounded-full p-1 text-faint transition-colors hover:text-ink',
                    'opacity-0 group-hover/note-row:opacity-100 focus-visible:opacity-100',
                  )}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
