import { X } from 'lucide-react'
import { useState } from 'react'
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
} from '@/domain/notes'
import { normalizeWhitespace } from '@/lib/text'
import { cn } from '@/lib/utils'

/** 两种入口：纯高亮（书签，不外送）与打标签（带语义，会告诉 AI）。 */
export type NoteDialogMode = 'highlight' | 'label'

/**
 * 新建 / 编辑一条标注的弹窗（纯高亮与打标签共用）。
 *
 * 打开时就已经带着被框选的那段原文 —— 框选在弹窗打开的瞬间就没了（点进输入框会清掉
 * 页面选区），所以原文与锚点由调用方在框选那一刻捕获好传进来，这里只负责选标签与写备注。
 * 状态由挂载决定：调用方用 `key` 重挂载来重置草稿，不在 effect 里同步 props。
 *
 * 「打标签」的默认路径是**只点标签、一个字都不写**：标签必须能独立表达完整意思，
 * 备注只在「这段推导需要解释」这类少数情况才用得上（因此它可以留空）。
 */
export function NoteDialog({
  mode,
  quote,
  labels,
  body,
  suggestions = [],
  onCancel,
  onSubmit,
  onDelete,
}: {
  mode: NoteDialogMode
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

  // 打标签这条路径要求「有标签或有备注」：两者都空等于一条纯高亮，走另一枚按钮就行
  const canSave = mode === 'highlight' || picked.length > 0 || draft.trim().length > 0

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
    if (busy || !canSave) return
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

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="w-[min(520px,100%)]">
        <DialogHeader>
          <DialogTitle>{mode === 'highlight' ? '高亮' : '给这段打标签'}</DialogTitle>
          <DialogDescription>
            {mode === 'highlight'
              ? '正文里会留下一条高亮标记，这是你自己的书签，不会告诉 AI。'
              : '带标签的标注会告诉 AI「这是我做错的 / 我没懂的」，出题与点评会优先照顾它。'}
          </DialogDescription>
        </DialogHeader>

        <blockquote className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border-l-2 border-accent/40 bg-canvas/40 px-2.5 py-1.5 text-xs leading-relaxed text-muted">
          {normalizeWhitespace(quote)}
        </blockquote>

        {mode === 'label' ? (
          <div className="mt-3">
            <DialogField label="标签" hint={`可多选，最多 ${MAX_NOTE_LABELS} 个。`}>
              <div className="flex flex-wrap gap-1.5">
                {candidates.map((candidate) => {
                  const active = picked.includes(candidate.id)
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      aria-pressed={active}
                      title={candidate.hint}
                      disabled={!active && atCap}
                      onClick={() => toggle(candidate.id)}
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-xs transition-colors disabled:opacity-40',
                        active
                          ? 'border-accent/50 bg-accent-soft text-accent'
                          : 'border-line/70 bg-elevated/50 text-ink-soft hover:border-accent/40 hover:text-accent',
                      )}
                    >
                      {candidate.name}
                    </button>
                  )
                })}
              </div>
            </DialogField>

            {picked.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {picked.map((label) => (
                  <Badge key={label} tone="accent" className="gap-1">
                    {candidates.find((item) => item.id === label)?.name ?? label}
                    <button
                      type="button"
                      aria-label={`移除标签 ${label}`}
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
                placeholder="自定义标签（项目里可复用）"
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
                添加
              </Button>
            </div>
          </div>
        ) : null}

        <div className="mt-3">
          <DialogField
            label={mode === 'highlight' ? '备注（可选）' : '备注（可选，默认不发送给 AI）'}
            hint="Enter 换行，Esc 取消。"
          >
            <Textarea
              autoFocus={mode === 'highlight'}
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
              placeholder={
                mode === 'highlight' ? '为什么标这句？（可留空）' : '需要解释时再写，标签已经说明了大意'
              }
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
                删除
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={() => void submit()} disabled={!canSave || busy}>
              保存
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