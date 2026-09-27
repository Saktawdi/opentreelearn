import { X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogField,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { NoteLabel } from '@/domain/models'
import {
  MAX_NOTE_LABELS,
  NOTE_LABEL_MAX,
  NOTE_LABELS,
  normalizeNoteLabel,
  normalizeNoteLabels,
  noteHintDisplay,
  noteLabelDisplay,
} from '@/domain/notes'
import { MarkdownView } from '@/lib/markdown/MarkdownView'
import { cn } from '@/lib/utils'

/**
 * 新建 / 编辑一条标注的统一弹窗（高亮与打标签合二为一）。
 *
 * 统一交互：
 * - 不选任何标签直接保存：作为普通的纯高亮书签（正文画淡底标记，默认不打扰 AI）；
 * - 选中标签（如 [错题] [没懂] [关键] [例题]）：作为带语义的标注，同步给 AI 并在出题、复习与点评时优先关注；
 * - 备注（可选）：需要额外说明或记录思考时填写。
 */
export function NoteDialog({
  quote,
  labels,
  body,
  suggestions = [],
  onCancel,
  onSubmit,
  onDelete,
}: {
  quote: string
  labels?: NoteLabel[]
  body?: string
  /** 项目里用过的标签：一起作为候选，避免同一个意思被写成两种标签 */
  suggestions?: NoteLabel[]
  onCancel: () => void
  onSubmit: (input: { labels: NoteLabel[]; body?: string }) => void
  onDelete?: () => void
}) {
  const [picked, setPicked] = useState<NoteLabel[]>(labels ?? [])
  const [draft, setDraft] = useState(body ?? '')
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)

  const candidates = buildCandidates(suggestions)
  const atCap = picked.length >= MAX_NOTE_LABELS

  const toggle = (label: NoteLabel) => {
    setPicked((current) =>
      current.includes(label)
        ? current.filter((item) => item !== label)
        : current.length >= MAX_NOTE_LABELS
          ? current
          : [...current, label],
    )
  }

  const addCustom = () => {
    const label = normalizeNoteLabel(custom)
    if (!label || picked.includes(label) || atCap) return
    setPicked((current) => [...current, label])
    setCustom('')
  }

  const submit = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onSubmit({
        labels: normalizeNoteLabels(picked),
        ...(draft.trim() ? { body: draft.trim() } : {}),
      })
    } finally {
      setBusy(false)
    }
  }

  const { t } = useTranslation('chat')
  const isEditing = Boolean(onDelete)
  const title = isEditing ? t('note.editTitle') : t('note.addTitle')
  const isPlainHighlight = picked.length === 0

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="w-[min(520px,100%)]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isPlainHighlight ? t('note.highlightDesc') : t('note.labeledDesc')}
          </DialogDescription>
        </DialogHeader>

        <blockquote className="max-h-28 overflow-y-auto rounded-md border-l-2 border-accent/40 bg-canvas/40 px-2.5 py-1.5 text-muted">
          {/* 存的是**源文**（公式连同 $ 一起），这里按 Markdown 渲染出来才好看；
              保存与复制给模型的仍是源文本身 */}
          <MarkdownView content={quote} className="text-xs" />
        </blockquote>

        <div className="mt-3">
          <DialogField
            label={t('note.labelsField')}
            hint={t('note.labelsHint', { max: MAX_NOTE_LABELS })}
          >
            <div className="flex flex-wrap gap-1.5">
              {candidates.map((candidate) => {
                const active = picked.includes(candidate.id)
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    aria-pressed={active}
                    title={noteHintDisplay(candidate.id)}
                    disabled={!active && atCap}
                    onClick={() => toggle(candidate.id)}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-xs transition-colors disabled:opacity-40',
                      active
                        ? 'border-accent/50 bg-accent-soft text-accent'
                        : 'border-line/70 bg-elevated/50 text-ink-soft hover:border-accent/40 hover:text-accent',
                    )}
                  >
                    {noteLabelDisplay(candidate.id)}
                  </button>
                )
              })}
            </div>
          </DialogField>

          {picked.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {picked.map((label) => (
                <Badge key={label} tone="accent" className="gap-1">
                  {noteLabelDisplay(label)}
                  <button
                    type="button"
                    aria-label={t('note.removeLabel', { label })}
                    onClick={() => toggle(label)}
                    className="text-accent/70 transition-colors hover:text-accent"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          ) : null}

          <div className="mt-2 flex items-center gap-2">
            <Input
              value={custom}
              maxLength={NOTE_LABEL_MAX}
              placeholder={t('note.customLabelPlaceholder')}
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addCustom()
                }
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!normalizeNoteLabel(custom) || atCap}
              onClick={addCustom}
            >
              {t('note.addLabel')}
            </Button>
          </div>
        </div>

        <div className="mt-3">
          <DialogField
            label={t('note.commentField')}
            hint={t('note.commentHint')}
          >
            <Textarea
              rows={3}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void submit()
                }
                if (event.key === 'Escape') onCancel()
              }}
              placeholder={t('note.commentPlaceholder')}
            />
          </DialogField>
        </div>

        <DialogFooter className="justify-between">
          <div>
            {onDelete ? (
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  onDelete()
                }}
              >
                {t('action.delete')}
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
              {t('action.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void submit()} disabled={busy}>
              {isPlainHighlight ? t('note.saveHighlight') : t('note.saveNote')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface Candidate {
  id: NoteLabel
  name: string
  hint?: string
}

/** 候选标签：内置在前，项目里用过的接上，同名去重（内置的展示名优先）。 */
function buildCandidates(suggestions: NoteLabel[]): Candidate[] {
  const candidates: Candidate[] = NOTE_LABELS.map((entry) => ({
    id: entry.id,
    name: entry.name,
    hint: entry.hint,
  }))
  for (const label of suggestions) {
    if (candidates.some((entry) => entry.id === label)) continue
    candidates.push({ id: label, name: label })
  }
  return candidates
}