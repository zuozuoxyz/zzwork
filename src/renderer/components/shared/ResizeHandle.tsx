import { useCallback, useEffect, useRef } from 'react'

interface ResizeHandleProps {
  position: 'left' | 'right'
  onResize: (delta: number) => void
}

export default function ResizeHandle({ position, onResize }: ResizeHandleProps): JSX.Element {
  const dragging = useRef(false)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
  }, [])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      onResize(position === 'left' ? e.movementX : -e.movementX)
    }
    const onMouseUp = () => {
      dragging.current = false
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [position, onResize])

  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        width: 4,
        cursor: 'col-resize',
        background: 'transparent',
        flexShrink: 0,
        zIndex: 10,
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        (e.target as HTMLElement).style.background = 'rgba(0, 122, 204, 0.5)'
      }}
      onMouseLeave={(e) => {
        if (!dragging.current) {
          (e.target as HTMLElement).style.background = 'transparent'
        }
      }}
    />
  )
}
