import { create } from 'zustand'

export interface Tab {
  id: string
  path: string
  title: string
  dirty: boolean
}

interface EditorStore {
  openTabs: Tab[]
  activeTabId: string | null
  fileContent: string

  openFile: (path: string, title: string, content: string) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  setFileContent: (content: string) => void
  markDirty: (id: string) => void
  markClean: (id: string) => void
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  openTabs: [],
  activeTabId: null,
  fileContent: '',

  openFile: (path, title, content) => {
    const state = get()
    const existing = state.openTabs.find((t) => t.path === path)
    if (existing) {
      set({ activeTabId: existing.id, fileContent: content })
      return
    }
    const tab: Tab = {
      id: `${path}-${Date.now()}`,
      path,
      title,
      dirty: false
    }
    set({
      openTabs: [...state.openTabs, tab],
      activeTabId: tab.id,
      fileContent: content
    })
  },

  closeTab: (id) => {
    const state = get()
    const idx = state.openTabs.findIndex((t) => t.id === id)
    const newTabs = state.openTabs.filter((t) => t.id !== id)
    let newActiveId = state.activeTabId
    if (state.activeTabId === id) {
      if (newTabs.length === 0) {
        newActiveId = null
      } else {
        const newIdx = Math.min(idx, newTabs.length - 1)
        newActiveId = newTabs[newIdx].id
      }
    }
    set({ openTabs: newTabs, activeTabId: newActiveId })
  },

  setActiveTab: (id) => {
    set({ activeTabId: id })
  },

  setFileContent: (content) => {
    set({ fileContent: content })
  },

  markDirty: (id) => {
    set({
      openTabs: get().openTabs.map((t) =>
        t.id === id ? { ...t, dirty: true } : t
      )
    })
  },

  markClean: (id) => {
    set({
      openTabs: get().openTabs.map((t) =>
        t.id === id ? { ...t, dirty: false } : t
      )
    })
  }
}))
