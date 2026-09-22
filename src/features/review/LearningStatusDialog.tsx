import {
  Brain,
  Loader2,
  MinusCircle,
  PlusCircle,
  RefreshCw,
} from 'lucide-react'
import { useState } from 'react'
import type { Node } from '@/domain/models'
import {
  enrollmentOf,
  masterySourceLabel,
  reviewReasonOf,
  retentionLabel,
  assessmentStaleness,
} from '@/domain/review/enrollment'
import { GRADE_BAND_LABEL, gradeOfScore } from '@/domain/review/schedule'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatRelativeTime } from '@/lib/time'

import { useDecayClock } from '@/features/chat/useDecayClock'

interface LearningStatusDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  node: Node
  hasSummaryModel: boolean
  isSummarizing: boolean
  onGenerateAssessment: () => Promise<void>
  onEnrollInReview: () => Promise<void>
  onUnenrollFromReview: () => Promise<void>
  onStartSingleReview: () => void
}

/**
 * 学习状态与掌握度详情弹窗：
 * - 只在明确点击时打开，打开/关闭绝不请求模型；
 * - 依次展示：学习摘要、掌握度状态、评估依据、薄弱点、复习安排；
 * - 提供明确操作：「生成/更新学习评估」「加入/移出复习计划」「复习这个主题」；
 * - 来源明确标注（AI 评估 / 复习反馈 / 历史记录），不伪造。
 */
export function LearningStatusDialog({
  open,
  onOpenChange,
  node,
  hasSummaryModel,
  isSummarizing,
  onGenerateAssessment,
  onEnrollInReview,
  onUnenrollFromReview,
  onStartSingleReview,
}: LearningStatusDialogProps) {
  const [busy, setBusy] = useState(false)
  const now = useDecayClock()

  const mastery = node.mastery
  const enrolled = enrollmentOf(node) === 'enabled'
  const sourceLabel = masterySourceLabel(node)
  const staleness = assessmentStaleness(node.assessmentMeta, node)
  const reason = reviewReasonOf(node, now)
  const retention = retentionLabel(node, now)

  const handleEnroll = async () => {
    setBusy(true)
    try {
      await onEnrollInReview()
    } finally {
      setBusy(false)
    }
  }

  const handleUnenroll = async () => {
    setBusy(true)
    try {
      await onUnenrollFromReview()
    } finally {
      setBusy(false)
    }
  }

  const handleGenerate = async () => {
    setBusy(true)
    try {
      await onGenerateAssessment()
    } finally {
      setBusy(false)
    }
  }

  const formatDue = (due?: number | null) => {
    if (!due) return '无'
    const date = new Date(due)
    return `${date.getMonth() + 1}月${date.getDate()}日`
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(500px,100%)] p-6">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-accent" />
            <DialogTitle className="text-base font-semibold text-ink">
              学习状态详情 · 《{node.title}》
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted">
            查看掌握度依据、薄弱点与复习计划安排。
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-4 text-xs">
          {/* 1. 摘要与评估依据 */}
          <div className="rounded-xl border border-line/60 bg-surface/50 p-3.5 space-y-2">
            <div className="flex items-center justify-between text-2xs text-muted">
              <span className="font-medium text-ink">学习摘要</span>
              {node.assessmentMeta?.assessedAt ? (
                <span>评估于 {formatRelativeTime(node.assessmentMeta.assessedAt)}</span>
              ) : null}
            </div>
            <p className="leading-relaxed text-ink-soft">
              {node.summary || '尚未生成学习摘要'}
            </p>
            {staleness === 'newStudy' && (
              <p className="text-2xs text-accent">
                提示：生成评估后有新的学习对话，掌握度与摘要可能需要更新。
              </p>
            )}
            {staleness === 'otherVersion' && (
              <p className="text-2xs text-accent">
                提示：当前对话切换到了其它版本，评估基于历史另一版本。
              </p>
            )}
          </div>

          {/* 2. 掌握度与来源 */}
          <div className="rounded-xl border border-line/60 bg-surface/50 p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-2xs font-medium text-ink">当前掌握状态</span>
              <span className="rounded bg-elevated px-1.5 py-0.5 text-2xs text-muted border border-line/40">
                来源：{sourceLabel}
              </span>
            </div>
            {mastery ? (
              <div className="flex items-center gap-3">
                <span className="text-xl font-bold text-accent tabular-nums">
                  {mastery.score}
                </span>
                <div>
                  <span className="font-medium text-ink">
                    {GRADE_BAND_LABEL[gradeOfScore(mastery.score)]}
                  </span>
                  <p className="text-2xs text-faint">
                    {mastery.gradedAt
                      ? `最后评分于 ${formatRelativeTime(mastery.gradedAt)}`
                      : `评估于 ${formatRelativeTime(mastery.updatedAt)}`}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-2xs text-faint">
                还没有掌握度数据。生成学习评估后即可获得参考分数。
              </p>
            )}

            {/* 薄弱点 */}
            {mastery?.weakPoints && mastery.weakPoints.length > 0 ? (
              <div className="mt-2 border-t border-line/40 pt-2">
                <span className="text-2xs text-faint">上次评估发现的薄弱点：</span>
                <ul className="mt-1 list-disc pl-4 space-y-0.5 text-2xs text-ink-soft">
                  {mastery.weakPoints.map((pt, i) => (
                    <li key={i}>{pt}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {/* 3. 复习计划 */}
          <div className="rounded-xl border border-line/60 bg-surface/50 p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-2xs font-medium text-ink">复习计划</span>
              <span
                className={`rounded px-1.5 py-0.5 text-2xs font-medium ${
                  enrolled ? 'bg-accent-soft text-accent' : 'bg-elevated text-muted'
                }`}
              >
                {enrolled ? '已加入计划' : '未加入计划'}
              </span>
            </div>

            {enrolled ? (
              <div className="grid grid-cols-2 gap-2 text-2xs pt-1">
                <div>
                  <span className="text-faint">下次安排：</span>
                  <span className="text-ink font-medium">
                    {formatDue(node.review?.card.due)} ({reason.label})
                  </span>
                </div>
                <div>
                  <span className="text-faint">记忆保持率：</span>
                  <span className="text-ink font-medium">{retention}</span>
                </div>
              </div>
            ) : (
              <p className="text-2xs text-faint">
                未加入复习计划的主题不会产生到期提醒。
              </p>
            )}
          </div>
        </div>

        {/* 底部操作区 */}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-4">
          <Button
            variant="secondary"
            size="sm"
            disabled={!hasSummaryModel || isSummarizing || busy}
            onClick={handleGenerate}
            className="text-xs"
          >
            {isSummarizing ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                正在评估…
              </>
            ) : (
              <>
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
                {node.summary ? '更新学习评估' : '生成学习评估'}
              </>
            )}
          </Button>

          <div className="flex items-center gap-2">
            {enrolled ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={handleUnenroll}
                className="text-xs text-muted hover:text-danger"
              >
                <MinusCircle className="mr-1 h-3.5 w-3.5" />
                移出计划
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                disabled={!mastery || busy}
                onClick={handleEnroll}
                className="text-xs text-accent"
              >
                <PlusCircle className="mr-1 h-3.5 w-3.5" />
                加入复习计划
              </Button>
            )}

            <Button
              variant="primary"
              size="sm"
              disabled={!mastery}
              onClick={() => {
                onOpenChange(false)
                onStartSingleReview()
              }}
              className="text-xs"
            >
              复习这个主题
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}