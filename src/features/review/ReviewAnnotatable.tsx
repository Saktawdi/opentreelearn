import { useRef } from 'react'
import { MarkdownView } from '@/lib/markdown/MarkdownView'
import { bodyProps } from '@/features/chat/note-anchor'
import { useNoteHighlights } from '@/features/chat/useNoteHighlights'
import { useReviewMessageNotes } from './use-review-notes'

/**
 * 复习中心的「可标注正文」：登记源文与高亮区间，挂上正文标记属性供框选菜单定位。
 *
 * 与学习对话共用同一条锚定链路（note-anchor 按**字符串 key** 对位，不关心内容
 * 是节点消息还是复习消息）——复习消息本就持久化在会话文档里、id 稳定，锚点因此在
 * 重渲染与刷新后都能自愈找回。`source` 必须与喂给 MarkdownView 的字符串**完全一致**：
 * 锚点存的就是这段源文里的字符区间（题目与点评的评分标记已在外层剥掉）。
 *
 * 流式中的占位卡不接这个组件 —— 内容每帧都在变，锚下去就是错位。
 */
export function ReviewAnnotatableText({
  messageId,
  source,
  className,
}: {
  messageId: string
  source: string
  className?: string
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const notes = useReviewMessageNotes(messageId)
  useNoteHighlights(bodyRef, messageId, notes, source)

  return (
    <div ref={bodyRef} className={className} {...bodyProps(messageId)}>
      <MarkdownView content={source} />
    </div>
  )
}
