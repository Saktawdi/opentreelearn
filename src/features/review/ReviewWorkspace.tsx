import { ArrowLeft, BookOpen, NotebookText } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import type { Id, Note } from '@/domain/models'
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
import { bodyElement, registeredSource, revealNote } from '@/features/chat/note-anchor'
import { ReviewOverview } from './ReviewOverview'
import { ReviewPractice } from './ReviewPractice'
import { ReviewSummary } from './ReviewSummary'
import { ReviewSourcePanel } from './ReviewSourcePanel'
import { ReviewNoteHistoryPanel } from './ReviewNoteHistoryPanel'
import { LegacyReviewCenterDialog } from './LegacyReviewCenterDialog'
import { FreeAskPanel } from './FreeAskPanel'
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
 * - 概览另提供「自由问答」面板：随口问进度（今天学了什么）不必走一遍练习流程，
 *   问答只在内存里，不写节点、不改排期；
 * - 与学习工作区完全解耦，不创建 kind: 'review' 节点。
 */
export function ReviewWorkspace({ projectId, onLeave }: ReviewWorkspaceProps) {
  const { t } = useTranslation('review')
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
  const noteHistoryOpen = useReviewSessionStore((state) => state.noteHistoryOpen)
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
  const resumeSession = useReviewSessionStore((state) => state.resumeSession)
  const toggleSource = useReviewSessionStore((state) => state.toggleSource)
  const setSourceOpen = useReviewSessionStore((state) => state.setSourceOpen)
  const toggleNoteHistory = useReviewSessionStore((state) => state.toggleNoteHistory)
  const setNoteHistoryOpen = useReviewSessionStore((state) => state.setNoteHistoryOpen)
  const askFollowup = useReviewSessionStore((state) => state.askFollowup)
  const ensureContent = useReviewSessionStore((state) => state.ensureCurrentItemContent)

  // 查阅资料的节点 ID（默认为当前练习节点）
  const [inspectedNodeId, setInspectedNodeId] = useState<Id | null>(null)
  const [legacyHistoryOpen, setLegacyHistoryOpen] = useState(false)
  const [freeAskOpen, setFreeAskOpen] = useState(false)

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

  /**
   * 笔记历史条目的定位：标注锚在两类内容上，去处的组件也不同。
   *
   * - 节点对话消息（学习期标注、复习期在资料面板里打的）：打开资料面板再定位 ——
   *   面板要渲染一拍才挂上锚点，轮询等待挂载完成；
   * - 复习消息（练习舞台里的题目/点评/回答）：舞台只渲染当前项，不在屏上就如实告知。
   */
  const revealNoteFromHistory = (note: Note) => {
    const isChatMessage = (messagesByNode[note.nodeId] ?? []).some(
      (message) => message.id === note.messageId,
    )
    if (isChatMessage) {
      setInspectedNodeId(note.nodeId)
      setSourceOpen(true)
      revealWhenMounted(note)
      return
    }
    if (!bodyElement(note.messageId) || !registeredSource(note.messageId)) {
      toast.info(t('workspace.toastNoteOffScreen'))
      return
    }
    revealNote(note)
  }

  const revealWhenMounted = (note: Note, attempts = 10) => {
    if (bodyElement(note.messageId) && registeredSource(note.messageId)) {
      revealNote(note)
      return
    }
    if (attempts <= 0) {
      toast.info(t('workspace.toastNoteNotRendered'))
      return
    }
    window.setTimeout(() => revealWhenMounted(note, attempts - 1), 150)
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
                {t('workspace.later')}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onLeave(session?.returnTo)}
                className="text-xs text-muted hover:text-ink gap-1.5"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                {t('workspace.backToLearning')}
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
                  {t('workspace.topicsProgress', {
                    current: session.cursor + 1,
                    count: session.items.length,
                  })}
                </span>
              </div>
            ) : (
              <span className="text-xs font-medium text-ink">
                {t('workspace.headerTitle', {
                  name: project?.name ?? t('workspace.untitledProject'),
                })}
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
                  {t('workspace.learningMaterials')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleNoteHistory}
                  className={`text-2xs gap-1.5 ${
                    noteHistoryOpen ? 'text-accent bg-accent-soft' : 'text-muted hover:text-ink'
                  }`}
                >
                  <NotebookText className="h-3.5 w-3.5" />
                  {t('workspace.noteHistory')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void endSession()}
                  className="text-2xs text-faint hover:text-ink"
                >
                  {t('workspace.endSession')}
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
              projectId={projectId}
              item={current}
              scoreBefore={activeNode.mastery?.score ?? 50}
              reviewBefore={activeNode.review}
              isLastItem={session.cursor === session.items.length - 1}
              streamingText={streaming?.text}
              streamingPurpose={streaming?.purpose}
              streamingDelivered={streaming?.delivered}
              streamingActivities={streaming?.activities}
              lastUndoneNotice={lastUndoneNotice}
              undoable={canUndo}
              onSaveDraft={(val) => void saveDraft(val)}
              onSubmitAnswer={(ans, ids) => void submitAnswer(ans, ids)}
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
              onAskFollowup={(question) => void askFollowup(question)}
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
                void resumeSession()
              }}
              onEndActiveSession={() => void endSession()}
              onInspectNodeSource={(nodeId) => {
                setInspectedNodeId(nodeId)
                setSourceOpen(true)
              }}
              hasLegacyCenters={centerNodes.length > 0}
              onOpenLegacyHistory={() => setLegacyHistoryOpen(true)}
              onOpenFreeAsk={() => setFreeAskOpen(true)}
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

      {/* 笔记历史抽屉：与资料面板互斥（store 层开关互相收起对方） */}
      {noteHistoryOpen && (
        <div className="relative w-80 lg:w-96 shrink-0 h-full z-20 shadow-panel">
          <ReviewNoteHistoryPanel
            session={session}
            currentNodeId={current?.nodeId}
            nodes={nodes}
            onClose={() => setNoteHistoryOpen(false)}
            onReveal={revealNoteFromHistory}
          />
        </div>
      )}

      {/* 自由问答面板：随口问进度用，问答不落库、不写节点 */}
      <FreeAskPanel
        open={freeAskOpen}
        onOpenChange={setFreeAskOpen}
        projectId={projectId}
        hasChatModel={hasChatModel}
      />

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