import { useState, useEffect } from 'react'
import { SettingOutlined } from '@ant-design/icons'
import { useProjectStore } from '../../stores/project.store'
import { useProgressStore } from '../../stores/progress.store'
import { useEditorStore } from '../../stores/editor.store'

function formatTime(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

interface Props {
  onSettingsClick?: () => void
}

export default function StatusBar({ onSettingsClick }: Props): JSX.Element {
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const projects = useProjectStore((s) => s.projects)
  const items = useProgressStore((s) => s.items)
  const activeTabId = useEditorStore((s) => s.activeTabId)

  const currentProject = projects.find((p) => p.id === currentProjectId)
  const doneCount = items.filter((i) => i.status === 'done').length
  const progressPct = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0

  const [now, setNow] = useState(formatTime)
  useEffect(() => {
    const timer = setInterval(() => setNow(formatTime()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div style={{
      height: 24,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 12px',
      fontSize: 12,
      backgroundColor: '#007acc',
      color: '#ffffff',
      userSelect: 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span>
          {currentProject ? `📁 ${currentProject.name}` : '未选择项目'}
        </span>
        {currentProject && items.length > 0 && (
          <span>进度 {doneCount}/{items.length} ({progressPct}%)</span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {activeTabId && <span>📝 编辑中</span>}
        <SettingOutlined
          style={{ cursor: 'pointer', opacity: 0.7 }}
          onClick={onSettingsClick}
        />
        <span>{now}</span>
      </div>
    </div>
  )
}
