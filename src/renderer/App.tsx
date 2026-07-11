import { useState } from 'react'
import { ConfigProvider } from 'antd'
import { antdTheme } from './styles/theme'
import './styles/global.css'

import AppShell from './components/layout/AppShell'
import StatusBar from './components/layout/StatusBar'
import AIPanel from './components/layout/AIPanel'
import ProjectTree from './components/project/ProjectTree'
import ProgressPanel from './components/progress/ProgressPanel'
import EditorTabs from './components/editor/EditorTabs'
import MonacoEditorWrapper from './components/editor/MonacoEditor'
import SettingsModal from './components/settings/SettingsModal'

export default function App(): JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <ConfigProvider theme={antdTheme}>
      <AppShell
        projectTree={<ProjectTree />}
        progressPanel={<ProgressPanel />}
        editorTabs={<EditorTabs />}
        editor={<MonacoEditorWrapper />}
        aiPanel={<AIPanel />}
        statusBar={<StatusBar onSettingsClick={() => setSettingsOpen(true)} />}
      />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </ConfigProvider>
  )
}
