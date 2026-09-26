import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import i18n from '@/i18n'
import { deleteProjectData, getRepositories } from '@/data'
import type { Id, Project } from '@/domain/models'
import { newId } from '@/lib/id'
import { clearLastOpenedNodeId } from '@/lib/last-opened-node'

export interface CreateProjectInput {
  name: string
  description?: string
  tags: string[]
}

interface ProjectsState {
  projects: Project[]
  loaded: boolean
  load: () => Promise<void>
  create: (input: CreateProjectInput) => Promise<Project>
  update: (id: Id, patch: Partial<Project>) => Promise<void>
  remove: (id: Id) => Promise<void>
}

export function collectTags(projects: Project[]): string[] {
  const tags = new Set<string>()
  for (const project of projects) {
    for (const tag of project.tags) {
      const trimmed = tag.trim()
      if (trimmed) tags.add(trimmed)
    }
  }
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

export const useProjectsStore = create<ProjectsState>()(
  immer((set) => ({
    projects: [],
    loaded: false,

    load: async () => {
      const projects = await getRepositories().projects.list()
      set((state) => {
        state.projects = projects
        state.loaded = true
      })
    },

    create: async (input) => {
      const now = Date.now()
      const project: Project = {
        id: newId(),
        name: input.name.trim() || i18n.t('common:fallback.unnamedProject'),
        description: input.description?.trim() || undefined,
        tags: input.tags.map((tag) => tag.trim()).filter(Boolean),
        createdAt: now,
        updatedAt: now,
      }

      await getRepositories().projects.create(project)
      set((state) => {
        state.projects.unshift(project)
      })
      return project
    },

    update: async (id, patch) => {
      const updatedAt = Date.now()
      await getRepositories().projects.update(id, { ...patch, updatedAt })
      set((state) => {
        const project = state.projects.find((item) => item.id === id)
        if (project) Object.assign(project, patch, { updatedAt })
        state.projects.sort((a, b) => b.updatedAt - a.updatedAt)
      })
    },

    remove: async (id) => {
      await deleteProjectData(id)
      clearLastOpenedNodeId(id)
      set((state) => {
        state.projects = state.projects.filter((project) => project.id !== id)
      })
    },
  })),
)

export function touchProject(id: Id): void {
  const { projects, update } = useProjectsStore.getState()
  const project = projects.find((item) => item.id === id)
  if (project) {
    void update(id, {}).catch(() => undefined)
  }
}