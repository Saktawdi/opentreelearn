import { History, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Message, Node } from '@/domain/models'
import { messageText } from '@/domain/messages'
import { MarkdownView } from '@/lib/markdown/MarkdownView'
import { formatRelativeTime } from '@/lib/time'
import { Button } from '@/components/ui/button'

interface LegacyReviewCenterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  centerNodes: Node[]
  messagesByNode: Record<string, Message[]>
  onSelectNode?: (nodeId: string) => void
}

/**
 * 旧复习中心历史记录浏览弹窗：
 * - 仅作为历史内容查看，不创建新会话、不自动恢复计划；
 * - 列出所有历史复习中心节点（包含已归档的）；
 * - 用户可以查看过去在复习中心里留下的笔记、回答与对话记录。
 */
export function LegacyReviewCenterDialog({
  open,
  onOpenChange,
  centerNodes,
  messagesByNode,
}: LegacyReviewCenterDialogProps) {
  const { t } = useTranslation('review')
  if (!open || centerNodes.length === 0) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <div className="flex h-[80vh] w-full max-w-3xl flex-col rounded-2xl border border-line bg-surface p-6 shadow-panel">
        <div className="flex items-center justify-between border-b border-line/60 pb-4">
          <div className="flex items-center gap-2">
            <History className="h-5 w-5 text-accent" />
            <h2 className="text-base font-semibold text-ink">{t('legacy.title')}</h2>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto pt-4 space-y-6 text-xs text-ink-soft">
          <p className="text-2xs text-muted">{t('legacy.intro')}</p>

          {centerNodes.map((center) => {
            const msgs = messagesByNode[center.id] ?? []
            return (
              <div key={center.id} className="rounded-xl border border-line/60 bg-elevated/40 p-4">
                <div className="flex items-center justify-between mb-3 border-b border-line/40 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-ink">{center.title}</span>
                    {center.status === 'archived' && (
                      <span className="rounded bg-elevated px-1.5 py-0.2 text-2xs text-faint">
                        {t('legacy.archived')}
                      </span>
                    )}
                  </div>
                  <span className="text-2xs text-faint">
                    {t('legacy.createdAt', { time: formatRelativeTime(center.createdAt) })}
                  </span>
                </div>

                {msgs.length === 0 ? (
                  <p className="text-2xs text-faint py-2">{t('legacy.emptyMessages')}</p>
                ) : (
                  <div className="space-y-3">
                    {msgs.map((msg) => (
                      <div
                        key={msg.id}
                        className={`rounded-lg p-3 ${
                          msg.role === 'assistant'
                            ? 'bg-surface border border-line/40'
                            : 'bg-accent-soft/30 border border-accent/20'
                        }`}
                      >
                        <div className="flex items-center justify-between text-2xs text-faint mb-1">
                          <span>{msg.role === 'assistant' ? t('roles.mentor') : t('roles.learner')}</span>
                          <span>{formatRelativeTime(msg.createdAt)}</span>
                        </div>
                        <MarkdownView content={messageText(msg)} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="border-t border-line/60 pt-4 flex justify-end">
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            {t('legacy.close')}
          </Button>
        </div>
      </div>
    </div>
  )
}