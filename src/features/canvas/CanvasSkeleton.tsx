import { Skeleton } from '@/components/ui/skeleton'

/**
 * 项目数据就绪前的加载骨架：镜像分栏工作区的真实布局
 * （左对话舞台 + 右微缩导航地图），撑住结构避免就绪瞬间的布局跳动。
 *
 * 数据没到位时「未选中节点」「0 个节点」「新项目」这些空态都是不可信的
 * （分不清是空项目还是没载完），一律不露面，统一由这里占场。
 */
export function CanvasSkeleton() {
  return (
    <div aria-busy="true" className="relative flex min-h-0 flex-1 overflow-hidden bg-canvas">
      {/* 左侧：主对话舞台 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-13 shrink-0 items-center justify-between border-b border-line/60 px-5">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-6 w-16 rounded-md" />
        </header>

        <div className="flex flex-1 flex-col justify-end gap-3 overflow-hidden px-5 pb-4">
          {/* 一问一答再一问：右对齐的是用户提问，与 MessageList 的气泡形态一致 */}
          <div className="ml-auto flex w-full max-w-[55%] rounded-xl rounded-br-sm border border-line/50 bg-elevated px-3.5 py-2.5">
            <Skeleton className="h-3 w-full" />
          </div>
          <div className="flex w-full max-w-[86%] flex-col gap-2 rounded-xl rounded-bl-sm border border-line/50 bg-surface/60 px-3.5 py-2.5">
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <div className="ml-auto flex w-full max-w-[40%] rounded-xl rounded-br-sm border border-line/50 bg-elevated px-3.5 py-2.5">
            <Skeleton className="h-3 w-full" />
          </div>
        </div>

        {/* 底部输入区占位 */}
        <div className="shrink-0 border-t border-line/60 px-5 py-4">
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      </div>

      {/* 左右两栏之间的分隔线 */}
      <div className="w-px shrink-0 bg-line/60" />

      {/* 右侧：知识树微缩导航地图 —— 点阵底 + 右上信息标 + 一簇未长成的节点 */}
      <div className="relative h-full w-80 shrink-0 overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            backgroundImage: 'radial-gradient(var(--color-grid) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
          }}
        />
        <div className="absolute right-3 top-3 z-10">
          <Skeleton className="h-6 w-28 rounded-md" />
        </div>
        <div aria-hidden className="absolute left-10 top-1/2 h-px w-24 -rotate-12 bg-line/60" />
        <div aria-hidden className="absolute left-32 top-[58%] h-px w-20 rotate-6 bg-line/60" />
        <Skeleton className="absolute left-8 top-[46%] h-3 w-3 rounded-full" />
        <Skeleton className="absolute left-32 top-[38%] h-2.5 w-2.5 rounded-full" />
        <Skeleton className="absolute left-[52%] top-[62%] h-2 w-2 rounded-full" />
      </div>
    </div>
  )
}
