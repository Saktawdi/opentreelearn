import { accountDatabaseName, GUEST_DATABASE_NAME, switchDatabase } from '@/data'
import { readAccountIdentity, readAccountToken } from '@/services/account/client'
import { useProjectsStore } from './projects-store'
import { useReviewSessionStore } from './review-session-store'
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
  if (changed) {
    // 换库就是换账号：内存里的复习会话属于上一个库，连在途请求一起丢弃 —— 否则迟到的
    // 模型回包或草稿防抖保存会把它写进新账号的库。库里的落盘内容不受影响：游客库的会话
    // 还在游客库里，账号库的会话也还在账号库。
    useReviewSessionStore.getState().reset()
    await reloadStores()
  }
  return changed
}

/**
 * 冷启动绑定库：只看本机记录（token + 上次登录的账号名），**不联网**。
 *
 * 为什么必须发生在载入 store 之前：以前账号恢复只挂在「我的」页，启动阶段先按游客库
 * 载入了项目 —— 登录用户刷新首页看到的是游客数据，期间写进去的东西在切库后还会「消失」。
 * 这里用本机记住的账号名直接切到账号库，token 是否还有效交给后台的 restore() 校验。
 *
 * @returns 是否需要联网确认身份 —— 本机有 token 却没记住账号名（只可能来自旧版本升级），
 *          这种情况没法本地算出库名，得等账号服务返回 loginName。
 */
export async function bindStoredAccountDatabase(): Promise<boolean> {
  const token = readAccountToken()
  const loginName = token ? readAccountIdentity() : null

  if (!loginName) {
    await bindAccountDatabase(null)
    return Boolean(token)
  }

  await bindAccountDatabase(loginName)
  return false
}

/**
 * 让内存状态跟上库里的内容（同步把远端记录写进库之后也要调一次）。
 *
 * 画布在流式生成时跳过重载：那会把正在写的消息流打断，等用户下次打开项目时自然刷新。
 * 复习会话刻意**不**在这里重置：普通同步刷新不能把正在做的一批复习清掉，库里的会话
 * 才是唯一真相，页面按它恢复（换库与清库会显式 reset，见 `bindAccountDatabase`）。
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