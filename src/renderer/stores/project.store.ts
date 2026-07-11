import { create } from 'zustand'
import type { Project, CreateProjectDTO, UpdateProjectDTO } from '../types/project'

interface ProjectStore {
  projects: Project[]
  currentProjectId: string | null
  loading: boolean

  loadProjects: () => Promise<void>
  createProject: (dto: CreateProjectDTO) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  setCurrentProject: (id: string | null) => void
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  currentProjectId: null,
  loading: false,

  loadProjects: async () => {
    set({ loading: true })
    const result = await window.api.project.list()
    if (result.ok) {
      set({ projects: result.data })
    }
    set({ loading: false })
  },

  createProject: async (dto) => {
    const result = await window.api.project.create(dto)
    if (result.ok) {
      await get().loadProjects()
      set({ currentProjectId: result.data.id })
    }
  },

  deleteProject: async (id) => {
    const result = await window.api.project.delete(id)
    if (result.ok) {
      const state = get()
      if (state.currentProjectId === id) {
        set({ currentProjectId: null })
      }
      await state.loadProjects()
    }
  },

  setCurrentProject: (id) => {
    set({ currentProjectId: id })
  }
}))
