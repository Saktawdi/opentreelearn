import { toast } from 'sonner'
import { errorMessage } from './utils'

export function runTask(task: Promise<unknown>, failureLabel = '操作失败'): void {
  void task.catch((error: unknown) => {
    toast.error(`${failureLabel}：${errorMessage(error)}`)
  })
}