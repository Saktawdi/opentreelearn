import { ImagePlus, Loader2, MessageSquareQuote, SendHorizontal, Square, X } from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/ui/tooltip'
import { getRepositories } from '@/data'
import type { Id, MessagePart, ModelRef } from '@/domain/models'
import { ENTER_FAST } from '@/lib/motion'
import { normalizeWhitespace } from '@/lib/text'
import { cn, errorMessage } from '@/lib/utils'
import { imagesFromClipboard, imagesFromDataTransfer } from '@/services/images'
import { isStreamingIn, useWorkspaceStore } from '@/stores/workspace-store'
import { useToolApprovalStore } from '@/stores/tool-approval-store'
import { ModelPicker } from '@/features/settings/ModelPicker'
import { ReasoningEffortInput } from '@/features/settings/ReasoningEffortInput'
import { AgentPermissionPicker } from './AgentPermissionPicker'
import { useSettingsStore } from '@/stores/settings-store'
import { useComposerDraft } from './useComposerDraft'

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

  const {
    loading: draftLoading,
    text,
    setText,
    quotes,
    addQuote,
    removeQuote,
    pending,
    attachFiles,
    removePending,
    clear,
  } = useComposerDraft(nodeId, projectId)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(
    ref,
    () => ({
      appendQuote: (value) => {
        addQuote(value)
        textareaRef.current?.focus()
      },
    }),
    [addQuote],
  )

  const resize = () => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`
  }

  // 草稿是 await 读回来的，恢复那一刻不会触发 onChange，高度得在这里补一次
  useEffect(() => {
    if (draftLoading) return
    resize()
  }, [draftLoading])

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

      // 图片已转存进 assets 表，草稿整条清掉（含待发图片的 blob）
      clear()
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
    !draftLoading &&
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
        // 拖放区在草稿读取期间也一直在：图片进来了也会被随后到达的草稿整个盖掉
        if (draftLoading) return
        void attachFiles(imagesFromDataTransfer(event.dataTransfer))
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

        {/* 草稿读取期间不渲染输入框：用户此刻打的字会被随后到达的草稿覆盖 */}
        {draftLoading ? (
          <Skeleton className="mx-3 my-3 h-5 w-2/3" />
        ) : (
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
                void attachFiles(files)
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
        )}

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
                // 草稿还在读时先别让图片进来：它会被随后到达的草稿整个覆盖掉
                disabled={draftLoading}
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
                void attachFiles(Array.from(event.target.files ?? []))
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