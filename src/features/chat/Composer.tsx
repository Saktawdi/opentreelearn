import { ImagePlus, Loader2, MessageSquareQuote, SendHorizontal, Square, X } from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { getRepositories } from '@/data'
import type { Asset, Id, MessagePart, ModelRef } from '@/domain/models'
import { ENTER_FAST } from '@/lib/motion'
import { normalizeWhitespace } from '@/lib/text'
import { cn, errorMessage } from '@/lib/utils'
import { createImageAsset, imagesFromClipboard, imagesFromDataTransfer } from '@/services/images'
import { isStreamingIn, useWorkspaceStore } from '@/stores/workspace-store'
import { useToolApprovalStore } from '@/stores/tool-approval-store'
import { ModelPicker } from '@/features/settings/ModelPicker'
import { ReasoningEffortInput } from '@/features/settings/ReasoningEffortInput'
import { AgentPermissionPicker } from './AgentPermissionPicker'
import { useSettingsStore } from '@/stores/settings-store'

interface PendingImage {
  asset: Asset
  url: string
}

/** 对话页的推理强度选择器：绑定到会话级临时覆盖，跟随当前对话所用的模型做智能匹配。 */
function ChatReasoningPicker({ chatModelRef }: { chatModelRef?: ModelRef | null }) {
  const reasoningOverride = useWorkspaceStore((state) => state.reasoningOverride)
  const setReasoningOverride = useWorkspaceStore((state) => state.setReasoningOverride)
  const providers = useSettingsStore((state) => state.settings.providers)

  const provider = chatModelRef
    ? providers.find((item) => item.id === chatModelRef.providerId) ?? null
    : null
  // 按钮显示生效值：覆盖（非 auto）优先，否则提供商配置
  const effective =
    reasoningOverride !== 'auto' ? reasoningOverride : (provider?.reasoningEffort ?? 'auto')

  return (
    <ReasoningEffortInput
      value={effective}
      onChange={setReasoningOverride}
      models={chatModelRef ? [chatModelRef.modelId] : []}
      modelConfigs={provider?.modelConfigs}
      className="h-7 px-1.5 text-muted hover:text-ink"
    />
  )
}

export interface ComposerHandle {
  /** 把框选的原文追加成输入框顶部的引用胶囊（重复片段不重复添加）。 */
  appendQuote: (text: string) => void
}

export function Composer({
  ref,
  nodeId,
  projectId,
  chatModelRef,
  onChatModelChange,
}: {
  ref?: Ref<ComposerHandle>
  nodeId: Id
  projectId: Id
  chatModelRef?: ModelRef | null
  onChatModelChange?: (ref: ModelRef | null) => void
}) {
  const sendMessage = useWorkspaceStore((state) => state.sendMessage)
  const isStreaming = useWorkspaceStore((state) => isStreamingIn(state.streaming, nodeId))
  // 全局同一时刻只有一轮生成；别节点在跑时这里只读不写，别去抢占单槽 abort
  const isStreamingElsewhere = useWorkspaceStore(
    (state) => Boolean(state.streaming && !state.streaming.error) && !isStreamingIn(state.streaming, nodeId),
  )
  const stopStreaming = useWorkspaceStore((state) => state.stopStreaming)
  const toolPermission =
    useWorkspaceStore((state) => state.projectSettings?.agentToolPermission) ?? 'prompt'
  const updateProjectSettings = useWorkspaceStore((state) => state.updateProjectSettings)
  const { t } = useTranslation('chat')

  const [text, setText] = useState('')
  const [quotes, setQuotes] = useState<string[]>([])
  const [pending, setPending] = useState<PendingImage[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingRef = useRef<PendingImage[]>([])

  useImperativeHandle(
    ref,
    () => ({
      appendQuote: (value) => {
        const clean = value.trim()
        if (!clean) return
        setQuotes((previous) => (previous.includes(clean) ? previous : [...previous, clean]))
        textareaRef.current?.focus()
      },
    }),
    [],
  )

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

  const removeQuote = (value: string) => {
    setQuotes((previous) => previous.filter((quote) => quote !== value))
  }

  const submit = async () => {
    const trimmed = text.trim()
    if (busy || isStreaming) return
    if (!trimmed && quotes.length === 0 && pending.length === 0) return

    setBusy(true)
    try {
      const repositories = getRepositories()
      const parts: MessagePart[] = []
      // 引用片段排在正文之前：读起来就是「先引用，后提问」
      for (const quote of quotes) parts.push({ type: 'quote', text: quote })
      if (trimmed) parts.push({ type: 'text', text: trimmed })

      for (const item of pending) {
        await repositories.assets.create(item.asset)
        parts.push({ type: 'image', assetId: item.asset.id })
      }

      for (const item of pending) URL.revokeObjectURL(item.url)
      setText('')
      setQuotes([])
      setPending([])
      const element = textareaRef.current
      if (element) element.style.height = 'auto'

      await sendMessage(nodeId, parts)
    } catch (error) {
      toast.error(t('error.sendFailed', { error: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  const canSend =
    (text.trim().length > 0 || quotes.length > 0 || pending.length > 0) &&
    !isStreaming &&
    !isStreamingElsewhere &&
    !busy

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
        'shrink-0 border-t border-line/60 p-3 transition-colors',
        dragging ? 'bg-accent-soft/40' : 'bg-transparent',
      )}
    >
      {/* 容器常驻（empty:hidden 兜住空态），最后一枚胶囊/图片退场时才有地方淡出 */}
      <div className="mb-2 flex flex-wrap gap-2 empty:hidden">
        <AnimatePresence initial={false}>
          {pending.map((item) => (
            <motion.div
              key={item.asset.id}
              initial={{ opacity: 0, scale: 0.88 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.88 }}
              transition={ENTER_FAST}
              className="group/img relative"
            >
              <img
                src={item.url}
                alt={item.asset.name ?? t('composer.pendingImageAlt')}
                className="h-16 w-16 rounded-md border border-line object-cover"
              />
              <button
                type="button"
                onClick={() => removePending(item.asset.id)}
                className="absolute -right-1.5 -top-1.5 rounded-full border border-line bg-canvas p-0.5 text-muted opacity-0 transition-opacity hover:text-ink group-hover/img:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className="rounded-lg border border-line/60 bg-canvas/40 transition-colors focus-within:border-accent/40">
        {/* 容器常驻（empty:hidden 兜住空态），最后一枚引用退场时才有地方淡出 */}
        <div className="flex flex-wrap gap-1.5 px-2 pt-2 empty:hidden">
          <AnimatePresence initial={false}>
            {quotes.map((quote) => (
              <motion.span
                key={quote}
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={ENTER_FAST}
                title={quote}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-accent/25 bg-accent-soft/50 py-0.5 pl-2 pr-1 text-2xs text-ink-soft"
              >
                <MessageSquareQuote className="h-3 w-3 shrink-0 text-accent/80" />
                <span className="max-w-[280px] truncate">{normalizeWhitespace(quote)}</span>
                <button
                  type="button"
                  aria-label={t('composer.removeQuoteAria')}
                  onClick={() => removeQuote(quote)}
                  className="rounded-full p-0.5 text-muted transition-colors hover:text-ink"
                >
                  <X className="h-3 w-3" />
                </button>
              </motion.span>
            ))}
          </AnimatePresence>
        </div>

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
          placeholder={t('composer.placeholder')}
          className="max-h-[180px] w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed text-ink outline-none placeholder:text-faint"
        />

        <div className="flex items-center justify-between px-2 pb-1.5">
          <div className="flex items-center gap-1">
            {onChatModelChange ? (
              <>
                <ModelPicker
                  value={chatModelRef}
                  onChange={onChatModelChange}
                  className="h-7 px-1.5 text-muted hover:text-ink"
                />
                {/* 模型在前，推理强度在后：跟随当前所选模型做智能匹配与在线快切 */}
                <ChatReasoningPicker chatModelRef={chatModelRef} />
                <AgentPermissionPicker
                  value={toolPermission}
                  onChange={(next) => {
                    void updateProjectSettings({ agentToolPermission: next })
                    // 拨到「自动允许」时，眼前这张卡不必再等一次点击 ——
                    // 用户的意图已经表达清楚了
                    if (next === 'always_allow') {
                      useToolApprovalStore.getState().respond('allow')
                    }
                  }}
                />
              </>
            ) : null}

            <Tooltip label={t('composer.insertImage')}>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => fileInputRef.current?.click()}
                className="text-muted hover:text-ink"
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
          </div>

          {isStreaming ? (
            <Tooltip label={t('composer.stop')}>
              <Button
                variant="subtle"
                size="icon-sm"
                onClick={stopStreaming}
                aria-label={t('composer.stop')}
                className="rounded-full"
              >
                <Square className="h-3 w-3" />
              </Button>
            </Tooltip>
          ) : (
            <Tooltip
              label={
                isStreamingElsewhere
                  ? t('composer.busyElsewhere')
                  : busy
                    ? t('composer.sending')
                    : t('composer.send')
              }
            >
              <Button
                variant="primary"
                size="icon-sm"
                onClick={() => void submit()}
                disabled={!canSend}
                aria-label={t('composer.send')}
                className="rounded-full"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SendHorizontal className="h-3.5 w-3.5" />}
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  )
}