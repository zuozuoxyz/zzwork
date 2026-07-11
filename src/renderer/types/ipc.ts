import type { Project, CreateProjectDTO, UpdateProjectDTO } from './project'
import type { ProgressItem, CreateProgressDTO, UpdateProgressDTO } from './progress'

export const IPC_CHANNELS = {
  PROJECT_LIST:    'project:list',
  PROJECT_GET:     'project:get',
  PROJECT_CREATE:  'project:create',
  PROJECT_UPDATE:  'project:update',
  PROJECT_DELETE:  'project:delete',
  PROJECT_ARCHIVE: 'project:archive',

  PROGRESS_LIST:   'progress:list',
  PROGRESS_CREATE: 'progress:create',
  PROGRESS_UPDATE: 'progress:update',
  PROGRESS_DELETE: 'progress:delete',
  PROGRESS_REORDER:'progress:reorder',

  FILE_READ:       'file:read',
  FILE_WRITE:      'file:write',
  FILE_LIST:       'file:list',
  FILE_DELETE:     'file:delete',
  FILE_CREATE:     'file:create',

  SETTINGS_GET:    'settings:get',
  SETTINGS_SET:    'settings:set',
  SETTINGS_GET_ALL:'settings:get-all',
} as const

export type IpcChannelMap = {
  [IPC_CHANNELS.PROJECT_LIST]:    { request: void;                    response: Project[] }
  [IPC_CHANNELS.PROJECT_GET]:     { request: string;                  response: Project | null }
  [IPC_CHANNELS.PROJECT_CREATE]:  { request: CreateProjectDTO;        response: Project }
  [IPC_CHANNELS.PROJECT_UPDATE]:  { request: { id: string; data: UpdateProjectDTO }; response: Project }
  [IPC_CHANNELS.PROJECT_DELETE]:  { request: string;                  response: void }
  [IPC_CHANNELS.PROJECT_ARCHIVE]: { request: string;                  response: Project }

  [IPC_CHANNELS.PROGRESS_LIST]:   { request: string;                  response: ProgressItem[] }
  [IPC_CHANNELS.PROGRESS_CREATE]: { request: CreateProgressDTO;       response: ProgressItem }
  [IPC_CHANNELS.PROGRESS_UPDATE]: { request: { id: string; data: UpdateProgressDTO }; response: ProgressItem }
  [IPC_CHANNELS.PROGRESS_DELETE]: { request: string;                  response: void }
  [IPC_CHANNELS.PROGRESS_REORDER]:{ request: { projectId: string; itemIds: string[] }; response: void }

  [IPC_CHANNELS.FILE_READ]:       { request: { projectId: string; filePath: string }; response: string }
  [IPC_CHANNELS.FILE_WRITE]:      { request: { projectId: string; filePath: string; content: string }; response: void }
  [IPC_CHANNELS.FILE_LIST]:       { request: string;                  response: string[] }
  [IPC_CHANNELS.FILE_DELETE]:     { request: { projectId: string; filePath: string }; response: void }
  [IPC_CHANNELS.FILE_CREATE]:     { request: { projectId: string; filePath: string; content?: string }; response: void }

  [IPC_CHANNELS.SETTINGS_GET]:    { request: string;                  response: string | null }
  [IPC_CHANNELS.SETTINGS_SET]:    { request: { key: string; value: string }; response: void }
  [IPC_CHANNELS.SETTINGS_GET_ALL]:{ request: void;                    response: Record<string, string> }
}
