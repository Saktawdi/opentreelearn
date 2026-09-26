import { Skeleton } from '@/components/ui/skeleton'

/**
 * 首页数据就绪前的加载骨架：镜像项目列表页的真实布局
 * （标题区 + 今日复习面板 + 搜索/操作行 + 三列卡片网格），
 * 替换掉启动期那行孤零零的「正在载入…」，也让就绪瞬间没有布局跳动。
 */
export function ProjectsPageSkeleton() {
  return (
    <div aria-busy="true" className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-7">
        {/* 标题区 */}
        <Skeleton className="h-6 w-28" />
        <Skeleton className="mt-2 h-3 w-16" />

        {/* 今日复习面板占位（中性配色：载入期间不预示「有到期卡片」） */}
        <div className="mt-5 rounded-lg border border-line/60 px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded-full" />
            <Skeleton className="h-3.5 w-14" />
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3.5 w-3/10" />
          </div>
        </div>

        {/* 搜索框 + 操作按钮行 */}
        <div className="mt-5 flex items-center justify-between">
          <Skeleton className="h-8 w-56 rounded-md" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-24 rounded-md" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
        </div>

        {/* 项目卡片网格 */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="rounded-lg border border-line bg-surface p-4">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="mt-2 h-3 w-full" />
              <Skeleton className="mt-1.5 h-3 w-4/5" />
              <div className="mt-3 flex items-center gap-1.5">
                <Skeleton className="h-4 w-10 rounded-full" />
                <Skeleton className="h-4 w-12 rounded-full" />
              </div>
              <div className="mt-3 border-t border-line pt-2.5">
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
