import { contextBridge } from 'electron'
import { projectApi } from './api/project.api'
import { progressApi } from './api/progress.api'
import { fileApi } from './api/file.api'
import { settingsApi } from './api/settings.api'

contextBridge.exposeInMainWorld('api', {
  project: projectApi,
  progress: progressApi,
  file: fileApi,
  settings: settingsApi,
})
