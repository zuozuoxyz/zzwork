export type ErrorCode =
  | 'DB_CONNECTION_FAILED'
  | 'DB_MIGRATION_FAILED'
  | 'DB_QUERY_FAILED'
  | 'FILE_NOT_FOUND'
  | 'FILE_READ_FAILED'
  | 'FILE_WRITE_FAILED'
  | 'FILE_ALREADY_EXISTS'
  | 'AI_API_KEY_MISSING'
  | 'AI_API_ERROR'
  | 'AI_TIMEOUT'
  | 'AI_RATE_LIMITED'
  | 'AI_INVALID_RESPONSE'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_NAME_DUPLICATE'
  | 'IPC_TIMEOUT'
  | 'IPC_UNKNOWN_CHANNEL'
  | 'INTERNAL'

export class AppError extends Error {
  public readonly code: ErrorCode
  public readonly detail?: string

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message)
    this.code = code
    this.detail = detail
    this.name = 'AppError'
  }
}

export interface IpcSuccess<T> {
  ok: true
  data: T
}

export interface IpcError {
  ok: false
  error: {
    code: ErrorCode
    message: string
    detail?: string
  }
}

export type IpcResult<T> = IpcSuccess<T> | IpcError
