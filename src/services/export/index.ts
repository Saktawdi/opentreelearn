import i18n from '@/i18n'
import { getRepositories } from '@/data'
import type { Project } from '@/domain/models'
import {
  buildTreeExportData,
  downloadFile,
  stringifyTreeExport,
  type RawTreeExportProject,
} from './tree-export'

export * from './tree-export'

/**
 * 导出项目为 .tree 文件对象或数据结构
 */
export async function getProjectTreeExportData(projectId: string): Promise<RawTreeExportProject> {
  const repos = getRepositories()
  const project = await repos.projects.get(projectId)
  if (!project) {
    throw new Error(i18n.t('common:errors.projectMissing'))
  }

  const nodes = await repos.nodes.listByProject(projectId)
  const messages = await repos.messages.listByProject(projectId)
  const notes = await repos.notes.listByProject(projectId)

  return buildTreeExportData(project, nodes, messages, notes)
}

/**
 * 导出项目并触发客户端下载 .tree 文件
 */
export async function exportProjectAsTreeFile(project: Project): Promise<void> {
  const exportData = await getProjectTreeExportData(project.id)
  const jsonString = stringifyTreeExport(exportData)
  // 清理文件名中不合法字符
  const safeName = (project.name || 'project').replace(/[\\/:*?"<>|]/g, '_')
  const filename = `${safeName}.tree`

  downloadFile(jsonString, filename, 'application/json;charset=utf-8')
}
