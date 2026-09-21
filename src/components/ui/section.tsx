import type { ReactNode } from 'react'

/** 设置类页面的小节：标题 + 说明 + 内容，顶部细线分隔。 */
export function Section({ title, description, children }: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="border-t border-line pt-5">
      <h2 className="text-base font-medium text-ink">{title}</h2>
      {description ? (
        <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  )
}