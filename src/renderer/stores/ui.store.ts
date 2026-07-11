import { create } from 'zustand'

interface UIStore {
  sidebarWidth: number
  aiPanelWidth: number
  aiPanelVisible: boolean
  theme: 'vs-dark' | 'light'

  resizeSidebar: (delta: number) => void
  resizeAIPanel: (delta: number) => void
  toggleAIPanel: () => void
  setTheme: (theme: 'vs-dark' | 'light') => void
}

const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 400
const AI_PANEL_MIN = 250
const AI_PANEL_MAX = 500

export const useUIStore = create<UIStore>((set, get) => ({
  sidebarWidth: parseInt(localStorage.getItem('sidebarWidth') || '280', 10),
  aiPanelWidth: parseInt(localStorage.getItem('aiPanelWidth') || '350', 10),
  aiPanelVisible: localStorage.getItem('aiPanelVisible') !== 'false',
  theme: 'vs-dark',

  resizeSidebar: (delta) => {
    const currentWidth = get().sidebarWidth
    const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, currentWidth + delta))
    localStorage.setItem('sidebarWidth', String(clamped))
    set({ sidebarWidth: clamped })
  },

  resizeAIPanel: (delta) => {
    const currentWidth = get().aiPanelWidth
    const clamped = Math.min(AI_PANEL_MAX, Math.max(AI_PANEL_MIN, currentWidth + delta))
    localStorage.setItem('aiPanelWidth', String(clamped))
    set({ aiPanelWidth: clamped })
  },

  toggleAIPanel: () => {
    set((s) => {
      const next = !s.aiPanelVisible
      localStorage.setItem('aiPanelVisible', String(next))
      return { aiPanelVisible: next }
    })
  },

  setTheme: (theme) => {
    set({ theme })
  }
}))
