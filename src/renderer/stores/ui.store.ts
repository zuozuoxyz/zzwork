import { create } from 'zustand'

interface UIStore {
  sidebarWidth: number
  aiPanelWidth: number
  aiPanelVisible: boolean
  theme: 'vs-dark' | 'light'

  resizeSidebar: (width: number) => void
  resizeAIPanel: (width: number) => void
  toggleAIPanel: () => void
  setTheme: (theme: 'vs-dark' | 'light') => void
}

const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 400
const AI_PANEL_MIN = 250
const AI_PANEL_MAX = 500

export const useUIStore = create<UIStore>((set) => ({
  sidebarWidth: parseInt(localStorage.getItem('sidebarWidth') || '280', 10),
  aiPanelWidth: parseInt(localStorage.getItem('aiPanelWidth') || '350', 10),
  aiPanelVisible: localStorage.getItem('aiPanelVisible') !== 'false',
  theme: 'vs-dark',

  resizeSidebar: (width) => {
    const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width))
    localStorage.setItem('sidebarWidth', String(clamped))
    set({ sidebarWidth: clamped })
  },

  resizeAIPanel: (width) => {
    const clamped = Math.min(AI_PANEL_MAX, Math.max(AI_PANEL_MIN, width))
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
