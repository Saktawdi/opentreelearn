import { ImagePlus, Loader2, SendHorizontal, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { getRepositories } from '@/data'
import type { Asset, Id, MessagePart } from '@/domain/models'
import { cn, errorMessage } from '@/lib/utils'
import { createImageAsset, imagesFromClipboard, imagesFromDataTransfer } from '@/services/images'
import { useWorkspaceStore } from '@/stores/workspace-store'

interface PendingImage {
  asset: Asset
  url: string
}

export function Composer({ nodeId, projectId }: { nodeId: Id; projectId: Id }) {
  const sendMessage = useWorkspaceStore((state) => state.sendMessage)
  const isStreaming = useWorkspaceStore((state) => state.streaming?.nodeId === nodeId)
  const stopStreaming = useWorkspaceStore((state) => state.stopStreaming)

  const [text, setText] = useState('')
  const [pending, setPending] = useState<PendingImage[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingRef = useRef<PendingImage[]>([])

  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  useEffect(
    () => () => {
      for (const item of pendingRef.current) URL.revokeObjectURL(item.url)
    },
    [],
  )

  const resize = () => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`
  }

  const attach = async (files: File[]) => {
    if (files.length === 0) return
    const created = await Promise.all(
      files.map(async (file) => {
        const asset = await createImageAsset(file, projectId)
        return { asset, url: URL.createObjectURL(asset.blob) }
      }),
    )
    setPending((previous) => [...previous, ...created])
  }

  const removePending = (assetId: Id) => {
    setPending((previous) => {
      const target = previous.find((item) => item.asset.id === assetId)
      if (target) URL.revokeObjectURL(target.url)
      return previous.filter((item) => item.asset.id !== assetId)
    })
  }

  const submit = async () => {
    const trimmed = text.trim()
    if (busy || isStreaming) return
    if (!trimmed && pending.length === 0) return

    setBusy(true)
    try {
      const repositories = getRepositories()
      const parts: MessagePart[] = []
      if (trimmed) parts.push({ type: 'text', text: trimmed })

      for (const item of pending) {
        await repositories.assets.create(item.asset)
        parts.push({ type: 'image', assetId: item.asset.id })
      }

      for (const item of pending) URL.revokeObjectURL(item.url)
      setText('')
      setPending([])
      const element = textareaRef.current
      if (element) element.style.height = 'auto'

      await sendMessage(nodeId, parts)
    } catch (error) {
      toast.error(`发送失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const canSend = (text.trim().length > 0 || pending.length > 0) && !isStreaming && !busy

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        void attach(imagesFromDataTransfer(event.dataTransfer))
      }}
      className={cn(
        'shrink-0 border-t border-line p-3 transition-colors',
        dragging ? 'bg-accent-soft/40' : 'bg-transparent',
      )}
    >
      {pending.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {pending.map((item) => (
            <div key={item.asset.id} className="group/img relative">
              <img
                src={item.url}
                alt={item.asset.name ?? '待发送图片'}
                className="h-16 w-16 rounded-lg border border-line object-cover"
              />
              <button
                type="button"
                onClick={() => removePending(item.asset.id)}
                className="absolute -right-1.5 -top-1.5 rounded-full border border-line bg-canvas p-0.5 text-muted opacity-0 transition-opacity hover:text-ink group-hover/img:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="rounded-xl border border-line bg-canvas/60 transition-colors focus-within:border-accent/50">
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          onChange={(event) => {
            setText(event.target.value)
            resize()
          }}
          onPaste={(event) => {
            const files = imagesFromClipboard(event.nativeEvent)
            if (files.length > 0) {
              event.preventDefault()
              void attach(files)
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder="继续追问，或粘贴一张图片…"
          className="max-h-[180px] w-full resize-none bg-transparent px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-muted/70"
        />

        <div className="flex items-center justify-between px-2.5 pb-2">
          <div className="flex items-center gap-1">
            <Tooltip label="插入图片">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => fileInputRef.current?.click()}
                className="text-muted"
              >
                <ImagePlus className="h-4 w-4" />
              </Button>
            </Tooltip>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => {
                void attach(Array.from(event.target.files ?? []))
                event.target.value = ''
              }}
            />
            <span className="text-[11px] text-muted/70">Enter 发送 · Shift+Enter 换行</span>
          </div>

          {isStreaming ? (
            <Button variant="subtle" size="sm" onClick={stopStreaming}>
              <Square className="h-3 w-3" />
              停止
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={() => void submit()} disabled={!canSend}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SendHorizontal className="h-3.5 w-3.5" />}
              发送
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}