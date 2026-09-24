import { Loader2, SendHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { BRANCH_QUICK_CHOICES } from '@/domain/defaults'
import { MarkdownView } from '@/lib/markdown/MarkdownView'
import { cn } from '@/lib/utils'

/**
 * 「新建子节点」的快捷小窗：框选文字后在这里挑一条快捷指令或自行输入，
 * 确认后被框选的原文作为引用胶囊、指令作为正文，一起发进新节点。
 *
 * 快捷指令「一点即发」：点击芯片立刻按该指令确认，不经过输入框；
 * 输入框里写自己的指令，Enter 或右下角发送按钮确认。勾选「记住选择」后，
 * 这次确认的指令（无论芯片还是自定义）会成为默认，下次不再弹窗直接发送。
 */
export function BranchDialog({
  quote,
  busy,
  rememberedPrompt,
  onCancel,
  onConfirm,
}: {
  quote: string
  busy: boolean
  /** 已记住的默认指令：匹配的芯片常亮，提示「记住选择」未来会直接发的那条 */
  rememberedPrompt?: string | null
  onCancel: () => void
  onConfirm: (prompt: string, remember: boolean) => void
}) {
  const [draft, setDraft] = useState('')
  const [remember, setRemember] = useState(false)

  const confirmDraft = () => {
    const prompt = draft.trim()
    if (!prompt || busy) return
    onConfirm(prompt, remember)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="w-[min(440px,100%)]">
        <DialogHeader>
          <DialogTitle>新建子节点</DialogTitle>
          <DialogDescription>
            选中的内容将收进引用胶囊，和下面选定的指令一起发送给新节点。
          </DialogDescription>
        </DialogHeader>

        <blockquote className="max-h-24 overflow-y-auto rounded-md border-l-2 border-accent/40 bg-canvas/40 px-2.5 py-1.5 text-muted">
          {/* 存的是**源文**（公式连同 $ 一起），渲染出来预览才好看；发送的仍是源文本身 */}
          <MarkdownView content={quote} className="text-xs" />
        </blockquote>

        <div className="mt-3 space-y-1.5">
          <span className="block text-sm font-medium text-ink-soft">快捷指令</span>
          <div className="flex flex-wrap gap-1.5">
            {BRANCH_QUICK_CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                title={choice.hint}
                disabled={busy}
                onClick={() => onConfirm(choice.prompt, remember)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50',
                  rememberedPrompt === choice.prompt
                    ? 'border-accent/50 bg-accent-soft text-accent'
                    : 'border-line/70 bg-elevated/50 text-ink-soft hover:border-accent/40 hover:text-accent',
                )}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>

        <Textarea
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              confirmDraft()
            }
          }}
          placeholder="或自己写指令，例如「用费曼技巧讲解这段内容」…"
          className="mt-3 resize-none"
        />

        <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-muted transition-colors hover:text-ink-soft">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            className="h-3.5 w-3.5 accent-accent"
          />
          记住选择，下次不再弹出窗口
        </label>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={confirmDraft}
            disabled={busy || !draft.trim()}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <SendHorizontal className="h-3.5 w-3.5" />
            )}
            发送
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
