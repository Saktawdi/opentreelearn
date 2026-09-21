import { accountDatabaseName, GUEST_DATABASE_NAME, switchDatabase } from '@/data'
import { useProjectsStore } from './projects-store'
import { useReviewStore } from './review-store'
import { useSettingsStore } from './settings-store'
import { useWorkspaceStore } from './workspace-store'

/**
 * 账号 ↔ 本地数据库的绑定。
 *
 * 数据按账号分库（游客用默认库），所以身份一变就必须换库并**重载所有 store**：
 * 内存里此刻还留着上一个账号的项目、节点与设置。换库 + 重载放在一个函数里完成，
 * 免得调用方只做了一半（换库没重载 = 界面上是别人的数据）。
 */
export async function bindAccountDatabase(loginName: string | null): Promise<boolean> {
  const target = loginName ? accountDatabaseName(loginName) : GUEST_DATABASE_NAME
  const changed = await switchDatabase(target)
  if (changed) await reloadStores()
  return changed
}

/**
 * 让内存状态跟上库里的内容（同步把远端记录写进库之后也要调一次）。
 *
 * 画布在流式生成时跳过重载：那会把正在写的消息流打断，等用户下次打开项目时自然刷新。
 */
export async function reloadStores(): Promise<void> {
  await Promise.all([
    useSettingsStore.getState().load(),
    useProjectsStore.getState().load(),
  ])

  // 到期概况也依赖库里内容（重载后可能整库换了），顺手标成未加载让页面自己刷新
  useReviewStore.getState().reset()

  const workspace = useWorkspaceStore.getState()
  if (!workspace.projectId) return
  if (workspace.streaming) return
  await workspace.openProject(workspace.projectId)
}