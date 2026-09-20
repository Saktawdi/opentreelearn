import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/utils'
import { importTreeFile } from '@/services/import'
import { useProjectsStore } from '@/stores/projects-store'

export function useImportProject() {
  const navigate = useNavigate()
  const loadProjects = useProjectsStore((state) => state.load)
  const [importing, setImporting] = useState(false)

  const handleFile = async (file: File) => {
    if (importing) return
    setImporting(true)
    try {
      const result = await importTreeFile(file)
      await loadProjects()
      toast.success(
        `已导入「${result.project.name}」：${result.stats.cards} 个节点，${result.stats.messages} 条对话`,
      )
      navigate(`/p/${result.project.id}`)
    } catch (error) {
      toast.error(`导入失败：${errorMessage(error)}`)
    } finally {
      setImporting(false)
    }
  }

  return { handleFile, importing }
}