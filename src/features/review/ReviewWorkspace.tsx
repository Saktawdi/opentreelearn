import { ArrowLeft, BookOpen } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Id } from '@/domain/models'
import {
  currentItem,
  undoableItem,
  type ReviewReturnTarget,
} from '@/domain/review/session'
import { useReviewSessionStore } from '@/stores/review-session-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { hasModel } from '@/services/llm/catalog'
import { Button } from '@/components/ui/button'
import { ReviewOverview } from './ReviewOverview'
import { ReviewPractice } from './ReviewPractice'
import { ReviewSummary } from './ReviewSummary'
import { ReviewSourcePanel } from './ReviewSourcePanel'
import { LegacyReviewCenterDialog } from './LegacyReviewCenterDialog'
import { legacyReviewCenters } from '@/domain/review/center'

interface ReviewWorkspaceProps {
  projectId: Id
  onLeave: (target?: ReviewReturnTarget) => void
}

/**
 * 项目内的独立复习工作区：
 * - 统一入口，支持概览（overview）、练习（practice）、小结（summary）三种状态自由切换；
 * - 顶部骨架稳定：返回学习 / 稍后继续、当前主题、批次进度；
 * - 原资料按需展开：桌面右侧侧边栏、窄屏抽屉；
 * - 刷新、浏览器后退都保留进度与草稿；
 * - 与学习工作区完全解耦，不创建 kind: 'review' 节点。
 */
export function ReviewWorkspace({ projectId, onLeave }: ReviewWorkspaceProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const sessionIdFromUrl = searchParams.get('session') ?? undefined

  const project = useWorkspaceStore((state) => state.project)
  const nodes = useWorkspaceStore((state) => state.nodes)
  const messagesByNode = useWorkspaceStore((state) => state.messagesByNode)
  const refreshNodes = useWorkspaceStore((state) => state.refreshNodes)

  const providers = useSettingsStore((state) => state.settings.providers)
  const defaultChatModelRef = useSettingsStore((state) => state.settings.defaultChatModelRef)
  const hasChatModel = hasModel(providers, defaultChatModelRef)

  const session = useReviewSessionStore((state) => state.session)
  const sourceOpen = useReviewSessionStore((state) => state.sourceOpen)
  const streaming = useReviewSessionStore((state) => state.streaming)
  const lastUndoneNotice = useReviewSessionStore((state) => state.lastUndoneNotice)

  const loadForProject = useReviewSessionStore((state) => state.loadForProject)
  const startBatch = useReviewSessionStore((state) => state.startBatch)
  const saveDraft = useReviewSessionStore((state) => state.saveDraft)
  const submitAnswer = useReviewSessionStore((state) => state.submitAnswer)
  const requestHint = useReviewSessionStore((state) => state.requestHint)
  const requestRephrase = useReviewSessionStore((state) => state.requestRephrase)
  const requestGiveUp = useReviewSessionStore((state) => state.requestGiveUp)
  const confirmRelearnReady = useReviewSessionStore((state) => state.confirmRelearnReady)
  const selectGrade = useReviewSessionStore((state) => state.selectGrade)
  const confirmCurrentGrade = useReviewSessionStore((state) => state.confirmCurrentGrade)
  const skipCurrent = useReviewSessionStore((state) => state.skipCurrent)
  const undoLastConfirmed = useReviewSessionStore((state) => state.undoLastConfirmed)
  const pauseAndLeave = useReviewSessionStore((state) => state.pauseAndLeave)
  const endSession = useReviewSessionStore((state) => state.endSession)
  const toggleSource = useReviewSessionStore((state) => state.toggleSource)
  const setSourceOpen = useReviewSessionStore((state) => state.setSourceOpen)
  const ensureContent = useReviewSessionStore((state) => state.ensureCurrentItemContent)

  // 查阅资料的节点 ID（默认为当前练习节点）
  const [inspectedNodeId, setInspectedNodeId] = useState<Id | null>(null)
  const [legacyHistoryOpen, setLegacyHistoryOpen] = useState(false)

  // 历史复习中心节点列表（兼容旧数据）
  const centerNodes = useMemo(() => legacyReviewCenters(nodes), [nodes])

  // 载入或恢复会话
  useEffect(() => {
    void loadForProject(projectId, sessionIdFromUrl)
  }, [projectId, sessionIdFromUrl, loadForProject])

  // 当会话创建或切出 sessionId 时同步到 URL，刷新后不丢会话
  useEffect(() => {
    if (session?.id && searchParams.get('session') !== session.id) {
      setSearchParams(
        (prev) => {
          prev.set('view', 'review')
          prev.set('session', session.id)
          return prev
        },
        { replace: true },
      )
    }
  }, [session?.id, searchParams, setSearchParams])

  const current = currentItem(session)
  const canUndo = Boolean(undoableItem(session))

  // 当前练习节点对象
  const activeNode = useMemo(() => {
    if (!current) return null
    return nodes.find((n) => n.id === current.nodeId) ?? null
  }, [current, nodes])

  const targetInspectNodeId = inspectedNodeId ?? current?.nodeId

  const handleLeaveToNode = (targetNodeId: Id) => {
    void pauseAndLeave()
    onLeave({ nodeId: targetNodeId, viewMode: 'chat' })
  }

  const handlePauseAndExit = async () => {
    await pauseAndLeave()
    onLeave(session?.returnTo)
  }

  // 模式判断：
  // 1. 无会话，或会话处于 paused 且在概览中 => 展示概览；
  // 2. 会话处于 active => 展示练习舞台；
  // 3. 会话处于 completed 或 ended => 展示小结。
  const isFinished = session?.status === 'completed' || session?.status === 'ended'
  const isPracticing = session?.status === 'active' && Boolean(current)

  return (
    <div className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-canvas">
      {/* 主舞台区 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 顶部常驻导航条 */}
        <header className="flex h-13 shrink-0 items-center justify-between border-b border-line/60 px-5 bg-surface/40 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            {isPracticing ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={handlePauseAndExit}
                className="text-xs text-muted hover:text-ink gap-1.5"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                稍后继续
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onLeave(session?.returnTo)}
                className="text-xs text-muted hover:text-ink gap-1.5"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                返回学习
              </Button>
            )}

            <span className="h-4 w-px bg-line/60" />

            {/* 当前主题标题与进度 */}
            {isPracticing && current ? (
              <div className="flex items-center gap-2">
                <span className="font-semibold text-xs text-ink truncate max-w-[240px]">
                  {current.title}
                </span>
                <span className="rounded-full bg-elevated px-2 py-0.5 text-2xs font-medium text-muted border border-line/60">
                  {session.cursor + 1} / {session.items.length} 个主题
                </span>
              </div>
            ) : (
              <span className="text-xs font-medium text-ink">
                {project?.name ?? '项目'} · 复习
              </span>
            )}
          </div>

          {/* 右侧动作 */}
          <div className="flex items-center gap-2">
            {isPracticing && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleSource}
                  className={`text-2xs gap-1.5 ${
                    sourceOpen ? 'text-accent bg-accent-soft' : 'text-muted hover:text-ink'
                  }`}
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  学习资料
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void endSession()}
                  className="text-2xs text-faint hover:text-ink"
                >
                  结束本次
                </Button>
              </>
            )}
          </div>
        </header>

        {/* 主内容路由 */}
        <main className="flex min-h-0 flex-1 overflow-hidden">
          {isFinished ? (
            <ReviewSummary
              session={session}
              onReturnToLearning={() => onLeave(session?.returnTo)}
              onStartAnotherBatch={() => {
                setSearchParams((prev) => {
                  prev.delete('session')
                  return prev
                })
                void loadForProject(projectId)
              }}
              canUndoLast={canUndo}
              onUndoLast={async () => {
                const ok = await undoLastConfirmed()
                if (ok) await refreshNodes()
              }}
            />
          ) : isPracticing && current && activeNode ? (
            <ReviewPractice
              item={current}
              scoreBefore={activeNode.mastery?.score ?? 50}
              reviewBefore={activeNode.review}
              isLastItem={session.cursor === session.items.length - 1}
              streamingText={streaming?.text}
              streamingPurpose={streaming?.purpose}
              lastUndoneNotice={lastUndoneNotice}
              undoable={canUndo}
              onSaveDraft={(val) => void saveDraft(val)}
              onSubmitAnswer={(ans) => void submitAnswer(ans)}
              onRequestHint={() => void requestHint()}
              onRequestRephrase={() => void requestRephrase()}
              onRequestGiveUp={() => void requestGiveUp()}
              onConfirmRelearnReady={() => void confirmRelearnReady()}
              onSelectGrade={(g) => selectGrade(g)}
              onConfirmGrade={async () => {
                const ok = await confirmCurrentGrade()
                if (ok) await refreshNodes()
              }}
              onSkip={() => void skipCurrent()}
              onUndoLast={async () => {
                const ok = await undoLastConfirmed()
                if (ok) await refreshNodes()
              }}
              onToggleSource={toggleSource}
              onRetry={() => void ensureContent()}
            />
          ) : (
            <ReviewOverview
              nodes={nodes}
              hasChatModel={hasChatModel}
              activeSession={session?.status === 'paused' ? session : null}
              onStartBatch={async (items) => {
                await startBatch({ projectId, items, nodes })
              }}
              onResumeSession={() => {
                if (session) {
                  useReviewSessionStore.getState().session!.status = 'active'
                  void ensureContent()
                }
              }}
              onEndActiveSession={() => void endSession()}
              onInspectNodeSource={(nodeId) => {
                setInspectedNodeId(nodeId)
                setSourceOpen(true)
              }}
              hasLegacyCenters={centerNodes.length > 0}
              onOpenLegacyHistory={() => setLegacyHistoryOpen(true)}
            />
          )}
        </main>
      </div>

      {/* 右侧按需展开的资料抽屉 */}
      {sourceOpen && targetInspectNodeId && (
        <div className="relative w-80 lg:w-96 shrink-0 h-full z-20 shadow-panel">
          <ReviewSourcePanel
            nodeId={targetInspectNodeId}
            nodes={nodes}
            messages={messagesByNode[targetInspectNodeId] ?? []}
            snapshotText={current?.sourceText}
            snapshotVersion={current?.sourceVersion}
            onClose={() => setSourceOpen(false)}
            onLeaveToNode={handleLeaveToNode}
          />
        </div>
      )}

      {/* 旧复习中心历史记录弹窗 */}
      <LegacyReviewCenterDialog
        open={legacyHistoryOpen}
        onOpenChange={setLegacyHistoryOpen}
        centerNodes={centerNodes}
        messagesByNode={messagesByNode}
        onSelectNode={(nodeId) => {
          setLegacyHistoryOpen(false)
          handleLeaveToNode(nodeId)
        }}
      />
    </div>
  )
}