import { useEditorStore } from '../../stores/editor.store'
import { CloseOutlined } from '@ant-design/icons'

export default function EditorTabs(): JSX.Element {
  const { openTabs, activeTabId, setActiveTab, closeTab } = useEditorStore()

  if (openTabs.length === 0) {
    return (
      <div style={{
        height: 36,
        backgroundColor: '#1e1e1e',
        borderBottom: '1px solid #3e3e3e',
      }} />
    )
  }

  return (
    <div style={{
      display: 'flex',
      height: 36,
      backgroundColor: '#252526',
      borderBottom: '1px solid #3e3e3e',
      overflowX: 'auto',
      overflowY: 'hidden',
    }}>
      {openTabs.map((tab) => {
        const isActive = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 12px',
              height: '100%',
              cursor: 'pointer',
              fontSize: 13,
              color: isActive ? '#ffffff' : '#999999',
              backgroundColor: isActive ? '#1e1e1e' : '#2d2d2d',
              borderRight: '1px solid #3e3e3e',
              borderTop: isActive ? '1px solid #007acc' : '1px solid transparent',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
          >
            <span>{tab.dirty ? '● ' : ''}{tab.title}</span>
            <CloseOutlined
              style={{ fontSize: 10, color: '#999' }}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
            />
          </div>
        )
      })}
    </div>
  )
}
