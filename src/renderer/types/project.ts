export type ProjectStatus = 'active' | 'doing' | 'done' | 'paused' | 'archived'

export interface Project {
  id: string
  name: string
  groupId: string | null
  path: string | null
  status: ProjectStatus
  description: string
  startDate: string | null
  endDate: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateProjectDTO {
  name: string
  groupId?: string | null
  description?: string
  startDate?: string | null
  endDate?: string | null
}

export interface UpdateProjectDTO {
  name?: string
  groupId?: string | null
  status?: ProjectStatus
  description?: string
  startDate?: string | null
  endDate?: string | null
  completedAt?: string | null
}

export interface ProjectGroup {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface CreateGroupDTO {
  name: string
}

export interface UpdateGroupDTO {
  name?: string
}
