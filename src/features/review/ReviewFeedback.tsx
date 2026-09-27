import { Check, Sparkles } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReviewGrade } from '@/domain/models'
import {
  GRADE_ACTION_LABEL_KEY,
  GRADE_HINT_LABEL_KEY,
  previewGrade,
  type GradePreview,
} from '@/domain/review/schedule'
import { suggestionFromMessages } from '@/domain/review/protocol'
import type { ReviewSessionItem } from '@/domain/review/session'
import { useDecayClock } from '@/features/chat/useDecayClock'
import { cn } from '@/lib/utils'

interface ReviewFeedbackProps {
  item: ReviewSessionItem
  scoreBefore: number
  reviewBefore?: Parameters<typeof previewGrade>[1]
  selectedGrade?: ReviewGrade
  onSelectGrade: (grade: ReviewGrade) => void
  disabled?: boolean
}

/**
 * 反馈与评分阶段的评分器：
 * - 只有用户回答后、进入反馈阶段才展示；
 * - 四档语义化单选组（没想起来 / 有点吃力 / 基本掌握 / 很熟悉），支持键盘直接导航；
 * - 选档只展示排期预览，明确确认后才保存；
 * - AI 建议标明「根据本次回答建议」，可覆盖；
 * - 使用真实调度函数预览下次排期天数与日期。
 */
export function ReviewFeedback({
  item,
  scoreBefore,
  reviewBefore,
  selectedGrade,
  onSelectGrade,
  disabled = false,
}: ReviewFeedbackProps) {
  // 词表键（grade.* / gradeHint.*）落在 common：数组形式让 t(`common:${...}`) 能过类型校验
  const { t, i18n } = useTranslation(['review', 'common'])
  const now = useDecayClock()

  // 尝试从助手反馈消息中解析 AI 判定标记
  const aiSuggestion = useMemo(() => {
    return suggestionFromMessages(item.messages)
  }, [item.messages])

  // 当前有效档位：手选优先，否则 AI 建议
  const activeGrade = selectedGrade ?? aiSuggestion ?? undefined

  // 四档真实调度预览
  const previews = useMemo(() => {
    const grades: ReviewGrade[] = ['again', 'hard', 'good', 'easy']
    const map = new Map<ReviewGrade, GradePreview>()
    for (const g of grades) {
      map.set(g, previewGrade(scoreBefore, reviewBefore, g, now))
    }
    return map
  }, [scoreBefore, reviewBefore, now])

  const formatDue = (preview?: GradePreview) => {
    if (!preview) return ''
    if (preview.scheduledDays === 0) return t('feedback.dueLaterToday')
    if (preview.scheduledDays === 1) return t('feedback.dueTomorrow')
    const date = new Intl.DateTimeFormat(i18n.language, {
      month: 'numeric',
      day: 'numeric',
    }).format(new Date(preview.due))
    return t('feedback.inDays', { date, count: preview.scheduledDays })
  }

  return (
    <div className="rounded-lg border border-line/60 bg-elevated/40 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-ink">{t('feedback.title')}</h4>
        {aiSuggestion ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 text-2xs text-accent">
            <Sparkles className="h-3 w-3" />
            {t('feedback.aiSuggestion', { grade: t(`common:${GRADE_ACTION_LABEL_KEY[aiSuggestion]}`) })}
          </span>
        ) : (
          <span className="text-2xs text-muted">{t('feedback.choosePrompt')}</span>
        )}
      </div>

      <div
        role="radiogroup"
        aria-label={t('feedback.groupAria')}
        className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4"
      >
        {(['again', 'hard', 'good', 'easy'] as ReviewGrade[]).map((grade) => {
          const isSelected = activeGrade === grade
          const isAi = aiSuggestion === grade
          const preview = previews.get(grade)

          return (
            <button
              key={grade}
              type="button"
              role="radio"
              aria-checked={isSelected}
              disabled={disabled}
              onClick={() => onSelectGrade(grade)}
              className={cn(
                'group relative flex flex-col justify-between rounded-lg border p-3 text-left transition-all',
                isSelected
                  ? 'border-accent bg-accent-soft/40 shadow-sm ring-1 ring-accent'
                  : 'border-line/70 bg-surface hover:border-line-strong hover:bg-elevated',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink">
                    {t(`common:${GRADE_ACTION_LABEL_KEY[grade]}`)}
                  </span>
                  {isSelected ? (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-ink">
                      <Check className="h-2.5 w-2.5 stroke-[3]" />
                    </span>
                  ) : isAi ? (
                    <span className="rounded bg-accent/20 px-1 py-0.2 text-2xs text-accent">
                      {t('feedback.aiBadge')}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-2xs leading-relaxed text-muted">
                  {t(`common:${GRADE_HINT_LABEL_KEY[grade]}`)}
                </p>
              </div>

              {preview ? (
                <div className="mt-3 border-t border-line/40 pt-2 text-2xs text-faint">
                  <span>{t('feedback.nextReview')}</span>
                  <span className="font-medium text-ink-soft">{formatDue(preview)}</span>
                </div>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}