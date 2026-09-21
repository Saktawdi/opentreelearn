import { useState } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import type { NoteKind } from '@/domain/models'
import { noteKindLabel } from '@/domain/notes'
import { normalizeWhitespace } from '@/lib/text'

/**
 * 新建/编辑一条笔记的弹窗。
 *
 * 打开时就已经带着被框选的那段原文 —— 框选在弹窗打开的瞬间就没了（点进输入框会清掉
 * 页面选区），所以原文与锚点由调用方在框选那一刻捕获好传进来，这里只负责写批注。
 * 状态由挂载决定：调用方用 `key` 重挂载来重置草稿，不在 effect 里同步 props。
 */
export function NoteDialog({
  kind,
  quote,
  body,
  onCancel,
  onSubmit,
  onDelete,
}: {
  kind: NoteKind
  quote: string
  body?: string
  onCancel: () => void
  onSubmit: (body: string) => void
  onDelete?: () => void
}) {
  const [draft, setDraft] = useState(body ?? '')
  const [busy, setBusy] = useState(false)

  // 注释笔记的意义就在于那段批注，空着等于只画了一条线，所以要求写点什么；
  // 高亮笔记的备注是可选的，留空就是纯标记。
  const canSave = kind === 'annotation' ? draft.trim().length > 0 : true

  const submit = async () => {
    if (busy || !canSave) return
    setBusy(true)
    try {
      await onSubmit(draft.trim())
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
      <DialogContent className="w-[min(480px,100%)]">
        <DialogHeader>
          <DialogTitle>{noteKindLabel(kind)}笔记</DialogTitle>
          <DialogDescription>
            {kind === 'highlight'
              ? '正文里会留下一条高亮标记，备注可留空。'
              : '批注会挂在这段文字上，需要时可以再改。'}
          </DialogDescription>
        </DialogHeader>

        <blockquote className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border-l-2 border-accent/40 bg-canvas/40 px-2.5 py-1.5 text-xs leading-relaxed text-muted">
          {normalizeWhitespace(quote)}
        </blockquote>

        <div className="mt-3">
          <DialogField
            label={kind === 'highlight' ? '备注（可选）' : '批注'}
            hint="Enter 换行，Esc 取消。"
          >
            <Textarea
              autoFocus
              rows={4}
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
                kind === 'highlight' ? '为什么标这句？' : '这句是什么意思、为什么重要…'
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
