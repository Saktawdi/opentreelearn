import { BookOpen, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Id, Message, Node } from '@/domain/models'
import { MarkdownView } from '@/lib/markdown/MarkdownView'
import { resolveThread } from '@/domain/thread/resolve'
import { messageText } from '@/domain/messages'
import { formatRelativeTime } from '@/lib/time'
import { Button } from '@/components/ui/button'

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
      aria-label="学习资料面板"
      className="flex h-full w-full flex-col border-l border-line/60 bg-surface/95 backdrop-blur-md"
    >
      {/* 头部 */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-line/60 px-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-accent" />
          <span className="text-xs font-medium text-ink">学习资料 · 《{node.title}》</span>
        </div>
        <div className="flex items-center gap-1">
          {onLeaveToNode ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onLeaveToNode(node.id)}
              className="text-2xs text-muted hover:text-ink"
              title="离开复习模式，直接打开该节点学习"
            >
              去原节点
            </Button>
          ) : null}
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭资料">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 版本不一致提示 */}
      {versionMismatch ? (
        <div className="border-b border-line/60 bg-accent-soft/30 px-4 py-2 text-2xs text-ink-soft">
          提示：该节点在别处产生了新的对话版本，本次出题依据的是题目生成时的题材快照。
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
            原对话（{visibleMessages.length}）
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
            出题依据快照
          </button>
        </div>
      ) : null}

      {/* 内容区域 */}
      <div className="flex-1 overflow-y-auto p-4 text-xs leading-relaxed text-ink-soft">
        {tab === 'snapshot' && snapshotText ? (
          <div className="rounded-md border border-line/60 bg-elevated/40 p-3">
            <p className="mb-2 text-2xs text-faint">本次出题依据的快照：</p>
            <MarkdownView content={snapshotText} />
          </div>
        ) : (
          <div className="space-y-4">
            {node.summary ? (
              <div className="rounded-md border border-line/60 bg-elevated/40 p-3">
                <p className="text-2xs font-medium text-muted">学习摘要</p>
                <p className="mt-1 text-ink">{node.summary}</p>
              </div>
            ) : null}

            {visibleMessages.length === 0 ? (
              <p className="py-6 text-center text-2xs text-muted">该主题暂无原对话记录</p>
            ) : (
              visibleMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`rounded-md border p-3 ${
                    msg.role === 'assistant'
                      ? 'border-line/60 bg-surface'
                      : 'border-accent/30 bg-accent-soft/20'
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between text-2xs text-muted">
                    <span className="font-medium">
                      {msg.role === 'assistant' ? '导师' : '学习者'}
                    </span>
                    <span>{formatRelativeTime(msg.createdAt)}</span>
                  </div>
                  <MarkdownView content={messageText(msg)} />
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </aside>
  )
}