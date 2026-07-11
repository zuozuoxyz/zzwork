import { useUIStore } from '../../stores/ui.store'

interface SidebarProps {
  top: React.ReactNode
  middle?: React.ReactNode
  bottom: React.ReactNode
}

export default function Sidebar({ top, middle, bottom }: SidebarProps): JSX.Element {
  const sidebarWidth = useUIStore((s) => s.sidebarWidth)

  return (
    <div
      style={{
        width: sidebarWidth,
        minWidth: 200,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#252526',
        borderRight: '1px solid #3e3e3e',
        flexShrink: 0,
      }}
    >
      <div style={{ flex: '0 0 auto', maxHeight: '35%', overflow: 'auto' }}>
        {top}
      </div>
      {middle && (
        <div style={{
          flex: '0 0 auto', maxHeight: '30%', overflow: 'auto',
          borderTop: '2px solid #3e3e3e',
        }}>
          {middle}
        </div>
      )}
      <div style={{
        flex: '1 1 auto',
        overflow: 'auto',
        borderTop: '2px solid #3e3e3e',
      }}>
        {bottom}
      </div>
    </div>
  )
}
