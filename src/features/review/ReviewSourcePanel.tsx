import { BookOpen, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Id, Message, Node } from '@/domain/models'
import { MarkdownView } from '@/lib/markdown/MarkdownView'
import { resolveThread } from '@/domain/thread/resolve'
import { messageSource } from '@/domain/messages'
import { formatRelativeTime } from '@/lib/time'
import { Button } from '@/components/ui/button'
import { SelectionMenu } from '@/features/chat/SelectionMenu'
import { MessageNotes } from '@/features/chat/MessageNotes'
import { ReviewAnnotatableText } from './ReviewAnnotatable'
import { useReviewMessageNotes } from './use-review-notes'

interface ReviewSourcePanelProps {
  nodeId: Id
  nodes: Node[]
  messages: Message[]
  /** 会话记录里实际出题依据的材料快照 */
  snapshotText?: string
  snapshotVersion?: string
  currentVersion?: string
  onClose: () => void
  onLeaveToNode?: (nodeId: Id) => void
}

/**
 * 原学习资料面板：
 * - 桌面在练习界面右侧展开，窄屏以抽屉弹出；
 * - 默认收起，关闭后回到完全相同的练习位置；
 * - 支持查看本次快照与最新原对话；
 * - 提供明确区分的「查看资料」与「离开复习去原节点」。
 */
export function ReviewSourcePanel({
  nodeId,
  nodes,
  messages,
  snapshotText,
  snapshotVersion,
  currentVersion,
  onClose,
  onLeaveToNode,
}: ReviewSourcePanelProps) {
  const { t } = useTranslation('review')
  const node = nodes.find((n) => n.id === nodeId)
  const [tab, setTab] = useState<'dialogue' | 'snapshot'>('dialogue')

  const versionMismatch = Boolean(
    snapshotVersion && currentVersion && snapshotVersion !== currentVersion,
  )

  const visibleMessages = useMemo(() => {
    if (!node) return []
    return resolveThread(node, messages).path
  }, [node, messages])

  // 按 Esc 关闭抽屉
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  if (!node) return null

  return (
    <aside
      role="region"
      aria-label={t('sourcePanel.panelAria')}
      className="flex h-full w-full flex-col border-l border-line/60 bg-surface/95 backdrop-blur-md"
    >
      {/* 头部 */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-line/60 px-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-accent" />
          <span className="text-xs font-medium text-ink">
            {t('sourcePanel.title', { title: node.title })}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onLeaveToNode ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onLeaveToNode(node.id)}
              className="text-2xs text-muted hover:text-ink"
              title={t('sourcePanel.openNodeTitle')}
            >
              {t('sourcePanel.openNode')}
            </Button>
          ) : null}
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('sourcePanel.close')}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 版本不一致提示 */}
      {versionMismatch ? (
        <div className="border-b border-line/60 bg-accent-soft/30 px-4 py-2 text-2xs text-ink-soft">
          {t('sourcePanel.versionMismatch')}
        </div>
      ) : null}

      {/* 切换 Tab（如果有出题快照文本） */}
      {snapshotText ? (
        <div className="flex shrink-0 border-b border-line/60 px-4 pt-2">
          <button
            type="button"
            onClick={() => setTab('dialogue')}
            className={`border-b-2 px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === 'dialogue'
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {t('sourcePanel.dialogueTab', { count: visibleMessages.length })}
          </button>
          <button
            type="button"
            onClick={() => setTab('snapshot')}
            className={`border-b-2 px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === 'snapshot'
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {t('sourcePanel.snapshotTab')}
          </button>
        </div>
      ) : null}

      {/* 内容区域 */}
      <div className="flex-1 overflow-y-auto p-4 text-xs leading-relaxed text-ink-soft">
        {tab === 'snapshot' && snapshotText ? (
          <div className="rounded-md border border-line/60 bg-elevated/40 p-3">
            <p className="mb-2 text-2xs text-faint">{t('sourcePanel.snapshotIntro')}</p>
            <MarkdownView content={snapshotText} />
          </div>
        ) : (
          <div className="space-y-4">
            {node.summary ? (
              <div className="rounded-md border border-line/60 bg-elevated/40 p-3">
                <p className="text-2xs font-medium text-muted">{t('sourcePanel.summaryLabel')}</p>
                <p className="mt-1 text-ink">{node.summary}</p>
              </div>
            ) : null}

            {visibleMessages.length === 0 ? (
              <p className="py-6 text-center text-2xs text-muted">{t('sourcePanel.emptyDialogue')}</p>
            ) : (
              visibleMessages.map((msg) => <SourceMessageCard key={msg.id} message={msg} />)
            )}
          </div>
        )}
      </div>

      {/* 资料里也只留标注与复制：追问是练习舞台的动作，资料面板保持「查阅」心智 */}
      <SelectionMenu key={nodeId} nodeId={nodeId} actions={['annotate', 'copy']} noteOrigin="review" />
    </aside>
  )
}

/**
 * 资料面板里的单条原对话卡片，接入划选打标签。
 *
 * 标注锚定到节点对话消息本体（id 全局稳定）：在复习里给资料打的标记与学习对话里
 * 打的标记落在同一条消息上，回到节点对话时高亮照常渲染 —— 这是「同一份资料、
 * 同一套标注」而不是两套平行的记录。
 */
function SourceMessageCard({ message }: { message: Message }) {
  const { t } = useTranslation('review')
  const notes = useReviewMessageNotes(message.id)
  const isAssistant = message.role === 'assistant'

  return (
    <div
      className={`rounded-md border p-3 ${
        isAssistant ? 'border-line/60 bg-surface' : 'border-accent/30 bg-accent-soft/20'
      }`}
    >
      <div className="mb-1 flex items-center justify-between text-2xs text-muted">
        <span className="font-medium">{isAssistant ? t('roles.mentor') : t('roles.learner')}</span>
        <span>{formatRelativeTime(message.createdAt)}</span>
      </div>
      <ReviewAnnotatableText messageId={message.id} source={messageSource(message)} />
      <MessageNotes notes={notes} className="mt-2" />
    </div>
  )
}