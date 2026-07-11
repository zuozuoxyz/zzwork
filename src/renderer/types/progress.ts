export type ProgressStatus = 'todo' | 'doing' | 'done' | 'blocked'
export type ProgressPriority = 'low' | 'medium' | 'high'

export interface ProgressItem {
  id: string
  projectId: string
  title: string
  status: ProgressStatus
  priority: ProgressPriority
  notes: string
  tags: string[]
  estimatedHours: number | null
  actualHours: number | null
  createdAt: string
  updatedAt: string
}

export interface CreateProgressDTO {
  projectId: string
  title: string
  status?: ProgressStatus
  priority?: ProgressPriority
  notes?: string
  tags?: string[]
  estimatedHours?: number
}

export interface UpdateProgressDTO {
  title?: string
  status?: ProgressStatus
  priority?: ProgressPriority
  notes?: string
  tags?: string[]
  estimatedHours?: number
  actualHours?: number
}
