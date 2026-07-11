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

export default function App(): JSX.Element {
  return (
    <ConfigProvider theme={antdTheme}>
      <AppShell
        projectTree={<ProjectTree />}
        progressPanel={<ProgressPanel />}
        editorTabs={<EditorTabs />}
        editor={<MonacoEditorWrapper />}
        aiPanel={<AIPanel />}
        statusBar={<StatusBar />}
      />
    </ConfigProvider>
  )
}
