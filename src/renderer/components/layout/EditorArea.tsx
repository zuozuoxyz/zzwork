interface EditorAreaProps {
  tabs: React.ReactNode
  editor: React.ReactNode
}

export default function EditorArea({ tabs, editor }: EditorAreaProps): JSX.Element {
  return (
    <div
      style={{
        flex: '1 1 auto',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 300,
        overflow: 'hidden',
      }}
    >
      <div style={{ flex: '0 0 auto' }}>{tabs}</div>
      <div style={{ flex: '1 1 auto', overflow: 'auto' }}>{editor}</div>
    </div>
  )
}
