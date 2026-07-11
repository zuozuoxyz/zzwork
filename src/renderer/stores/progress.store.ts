import { create } from 'zustand'
import type { ProgressItem, CreateProgressDTO, UpdateProgressDTO, ProgressStatus } from '../types/progress'

interface ProgressStore {
  items: ProgressItem[]
  filter: { status: ProgressStatus | 'all'; projectId: string | null }
  loading: boolean

  loadByProject: (projectId: string) => Promise<void>
  add: (dto: CreateProgressDTO) => Promise<void>
  update: (id: string, data: UpdateProgressDTO) => Promise<void>
  remove: (id: string) => Promise<void>
  setFilter: (filter: Partial<ProgressStore['filter']>) => void
}

export const useProgressStore = create<ProgressStore>((set, get) => ({
  items: [],
  filter: { status: 'all', projectId: null },
  loading: false,

  loadByProject: async (projectId) => {
    set({ loading: true, filter: { ...get().filter, projectId } })
    const result = await window.api.progress.list(projectId)
    if (result.ok) {
      set({ items: result.data })
    }
    set({ loading: false })
  },

  add: async (dto) => {
    const result = await window.api.progress.create(dto)
    if (result.ok) {
      const state = get()
      if (state.filter.projectId === dto.projectId) {
        await state.loadByProject(dto.projectId)
      }
    }
  },

  update: async (id, data) => {
    const result = await window.api.progress.update(id, data)
    if (result.ok) {
      const state = get()
      if (state.filter.projectId) {
        await state.loadByProject(state.filter.projectId)
      }
    }
  },

  remove: async (id) => {
    const result = await window.api.progress.delete(id)
    if (result.ok) {
      const state = get()
      if (state.filter.projectId) {
        await state.loadByProject(state.filter.projectId)
      }
    }
  },

  setFilter: (filter) => {
    set({ filter: { ...get().filter, ...filter } })
  }
}))
