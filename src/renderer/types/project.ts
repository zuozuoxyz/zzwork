export interface Project {
  id: string
  name: string
  path: string | null
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
}

export interface CreateProjectDTO {
  name: string
}

export interface UpdateProjectDTO {
  name?: string
  status?: 'active' | 'archived'
}
