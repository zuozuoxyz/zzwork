import { useUIStore } from '../../stores/ui.store'
import Sidebar from './Sidebar'
import EditorArea from './EditorArea'
import ResizeHandle from '../shared/ResizeHandle'

interface AppShellProps {
  projectTree: React.ReactNode
  progressPanel: React.ReactNode
  editorTabs: React.ReactNode
  editor: React.ReactNode
  aiPanel: React.ReactNode
  statusBar: React.ReactNode
}

export default function AppShell({
  projectTree,
  progressPanel,
  editorTabs,
  editor,
  aiPanel,
  statusBar,
}: AppShellProps): JSX.Element {
  const aiPanelVisible = useUIStore((s) => s.aiPanelVisible)
  const aiPanelWidth = useUIStore((s) => s.aiPanelWidth)
  const resizeSidebar = useUIStore((s) => s.resizeSidebar)
  const resizeAIPanel = useUIStore((s) => s.resizeAIPanel)

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#1e1e1e',
    }}>
      {/* Main content area */}
      <div style={{
        flex: '1 1 auto',
        display: 'flex',
        overflow: 'hidden',
      }}>
        {/* Left sidebar */}
        <Sidebar top={projectTree} bottom={progressPanel} />
        <ResizeHandle position="left" onResize={resizeSidebar} />

        {/* Editor area */}
        <EditorArea tabs={editorTabs} editor={editor} />

        {/* Right AI panel (collapsible) */}
        {aiPanelVisible && (
          <>
            <ResizeHandle position="right" onResize={resizeAIPanel} />
            <div
              style={{
                width: aiPanelWidth,
                minWidth: 250,
                height: '100%',
                backgroundColor: '#252526',
                borderLeft: '1px solid #3e3e3e',
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {aiPanel}
            </div>
          </>
        )}
      </div>

      {/* Status bar */}
      <div style={{
        flex: '0 0 auto',
        height: 24,
        borderTop: '1px solid #3e3e3e',
      }}>
        {statusBar}
      </div>
    </div>
  )
}
