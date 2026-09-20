import { RotateCcw } from 'lucide-react'
import { useEffect } from 'react'
import { isRouteErrorResponse, useRouteError } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/utils'

/**
 * 路由级兜底错误页。
 *
 * 之前整个应用没有 errorElement，任何渲染期异常都会让页面直接空白，
 * 排查时无迹可寻。这里把它变成一个可读的错误页，并把原始错误打到控制台。
 */
export function RouteError() {
  const error = useRouteError()

  useEffect(() => {
    console.error('[RouteError]', error)
  }, [error])

  const title = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : '页面渲染出错'
  const detail = isRouteErrorResponse(error) ? error.data?.toString() ?? '' : errorMessage(error)
  const stack = error instanceof Error ? error.stack : undefined

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-canvas px-6 text-center">
      <div className="w-full max-w-2xl rounded-lg border border-line bg-surface p-6 text-left">
        <h1 className="text-base font-medium text-ink">{title}</h1>
        {detail ? (
          <p className="mt-1 break-words font-mono text-xs leading-relaxed text-danger">
            {detail}
          </p>
        ) : null}
        {stack ? (
          <pre className="mt-4 max-h-64 overflow-auto rounded-md border border-line bg-canvas/60 p-3 font-mono text-2xs leading-relaxed text-muted">
            {stack}
          </pre>
        ) : null}
        <div className="mt-5 flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
            <RotateCcw className="h-3.5 w-3.5" />
            重新加载
          </Button>
          <a
            href="/"
            className="rounded-md px-2.5 py-1 text-sm text-muted transition-colors hover:text-ink"
          >
            返回项目列表
          </a>
        </div>
      </div>
    </div>
  )
}
