export interface ModelConfig {
  id: string
  name: string
  type: 'anthropic' | 'openai_compatible'
  baseUrl: string
  modelId: string
  isDefault: boolean
  createdAt: string
}

// Excludes apiKey — that's only in keychain
export interface ModelConfigDTO {
  name: string
  type: 'anthropic' | 'openai_compatible'
  baseUrl: string
  apiKey?: string       // only in create/update, never returned
  modelId: string
  isDefault?: boolean
}

export interface CreateModelDTO {
  name: string
  type: 'anthropic' | 'openai_compatible'
  baseUrl: string
  apiKey: string
  modelId: string
  isDefault?: boolean
}

export interface UpdateModelDTO {
  name?: string
  type?: 'anthropic' | 'openai_compatible'
  baseUrl?: string
  apiKey?: string
  modelId?: string
  isDefault?: boolean
}
