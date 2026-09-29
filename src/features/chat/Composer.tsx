import { useImperativeHandle, useRef, useState, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { getRepositories } from '@/data'
import type { Id, MessagePart, ModelRef } from '@/domain/models'
import { errorMessage } from '@/lib/utils'
import { imagesFromClipboard } from '@/services/images'
import { isStreamingIn, useWorkspaceStore } from '@/stores/workspace-store'
import { useToolApprovalStore } from '@/stores/tool-approval-store'
import { ModelPicker } from '@/features/settings/ModelPicker'
import { ReasoningEffortInput } from '@/features/settings/ReasoningEffortInput'
import { AgentPermissionPicker } from './AgentPermissionPicker'
import { useSettingsStore } from '@/stores/settings-store'
import { ComposerShell, type ComposerShellHandle } from './ComposerShell'
import { useComposerDraft } from './useComposerDraft'

/** 对话页的推理强度选择器：绑定到会话级临时覆盖，跟随当前对话所用的模型做智能匹配。 */
function ChatReasoningPicker({
  chatModelRef,
  compactOnMobile = false,
}: {
  chatModelRef?: ModelRef | null
  compactOnMobile?: boolean
}) {
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
      compactOnMobile={compactOnMobile}
    />
  )
}

export interface ComposerHandle {
  /** 把框选的原文追加成输入框顶部的引用胶囊（重复片段不重复添加）。 */
  appendQuote: (text: string) => void
}

/**
 * 对话页的输入框：在共用框体（`ComposerShell`）之上接上自己的三件事 ——
 * 按节点落 IndexedDB 的草稿、模型/推理/授权三个项目级拨杆、以及把引用与
 * 图片转成消息部件的发送流程。
 */
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

  const draft = useComposerDraft(nodeId, projectId)
  const { addQuote } = draft
  const [busy, setBusy] = useState(false)
  const shellRef = useRef<ComposerShellHandle>(null)

  useImperativeHandle(
    ref,
    () => ({
      appendQuote: (value) => {
        addQuote(value)
        shellRef.current?.focus()
      },
    }),
    [addQuote],
  )

  const submit = async () => {
    const trimmed = draft.text.trim()
    if (busy || isStreaming) return
    if (!trimmed && draft.quotes.length === 0 && draft.pending.length === 0) return

    setBusy(true)
    try {
      const repositories = getRepositories()
      const parts: MessagePart[] = []
      // 引用片段排在正文之前：读起来就是「先引用，后提问」
      for (const quote of draft.quotes) parts.push({ type: 'quote', text: quote })
      if (trimmed) parts.push({ type: 'text', text: trimmed })

      for (const item of draft.pending) {
        await repositories.assets.create(item.asset)
        parts.push({ type: 'image', assetId: item.asset.id })
      }

      // 图片已转存进 assets 表，草稿整条清掉（含待发图片的 blob）
      draft.clear()

      await sendMessage(nodeId, parts)
    } catch (error) {
      toast.error(t('error.sendFailed', { error: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  const canSend =
    !draft.loading &&
    (draft.text.trim().length > 0 || draft.quotes.length > 0 || draft.pending.length > 0) &&
    !isStreaming &&
    !isStreamingElsewhere &&
    !busy

  return (
    <ComposerShell
      ref={shellRef}
      draft={draft}
      onSubmit={submit}
      // 粘贴图片：与拖放/上传同一条 attachFiles 通道
      onPaste={(event) => {
        const files = imagesFromClipboard(event.nativeEvent)
        if (files.length > 0) {
          event.preventDefault()
          void draft.attachFiles(files)
        }
      }}
      canSubmit={canSend}
      busy={busy}
      streaming={isStreaming}
      onStop={stopStreaming}
      sendHint={isStreamingElsewhere ? t('composer.busyElsewhere') : undefined}
      placeholder={t('composer.placeholder')}
      toolbar={
        onChatModelChange ? (
          <>
            <ModelPicker
              value={chatModelRef}
              onChange={onChatModelChange}
              className="h-7 px-1.5 text-muted hover:text-ink"
              compactOnMobile
            />
            {/* 模型在前，推理强度在后：跟随当前所选模型做智能匹配与在线快切 */}
            <ChatReasoningPicker chatModelRef={chatModelRef} compactOnMobile />
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
              compactOnMobile
            />
          </>
        ) : null
      }
    />
  )
}
