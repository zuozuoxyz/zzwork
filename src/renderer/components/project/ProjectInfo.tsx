import { useState } from 'react'
import { Descriptions, Tag, Button, Input, Select, message, Popconfirm } from 'antd'
import { EditOutlined, SaveOutlined, CloseOutlined, PlayCircleOutlined, PauseCircleOutlined, CheckCircleOutlined, DeleteOutlined } from '@ant-design/icons'
import { useProjectStore } from '../../stores/project.store'
import { useEditorStore } from '../../stores/editor.store'
import type { ProjectStatus } from '../../types/project'

const { TextArea } = Input

const STATUS_OPTIONS: { value: ProjectStatus; label: string; color: string }[] = [
  { value: 'active', label: '进行中', color: '#007acc' },
  { value: 'doing', label: '开发中', color: '#d7ba7d' },
  { value: 'done', label: '已完成', color: '#4d9e4d' },
  { value: 'paused', label: '已暂停', color: '#d16969' },
  { value: 'archived', label: '已归档', color: '#6a6a6a' },
]

const STATUS_ICONS: Record<ProjectStatus, JSX.Element> = {
  active: <PlayCircleOutlined style={{ color: '#007acc' }} />,
  doing: <PlayCircleOutlined style={{ color: '#d7ba7d' }} />,
  done: <CheckCircleOutlined style={{ color: '#4d9e4d' }} />,
  paused: <PauseCircleOutlined style={{ color: '#d16969' }} />,
  archived: <DeleteOutlined style={{ color: '#6a6a6a' }} />,
}

export default function ProjectInfo(): JSX.Element {
  const { projects, groups, currentProjectId, loadProjects, setCurrentProject, deleteProject } = useProjectStore()
  const openFile = useEditorStore((s) => s.openFile)
  const activeTabId = useEditorStore((s) => s.activeTabId)

  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editStatus, setEditStatus] = useState<ProjectStatus>('active')
  const [editStart, setEditStart] = useState('')
  const [editEnd, setEditEnd] = useState('')
  const [saving, setSaving] = useState(false)

  const project = projects.find((p) => p.id === currentProjectId)
  const group = groups.find((g) => g.id === project?.groupId)

  // If a file is open in the editor, don't show project info
  if (activeTabId || !project) return <></>

  const handleEdit = () => {
    setEditName(project.name)
    setEditDesc(project.description || '')
    setEditStatus(project.status)
    setEditStart(project.startDate || '')
    setEditEnd(project.endDate || '')
    setEditing(true)
  }

  const handleSave = async () => {
    if (!editName.trim()) return
    setSaving(true)
    const r = await window.api.project.update(project.id, {
      name: editName.trim(),
      description: editDesc,
      status: editStatus,
      startDate: editStart || null,
      endDate: editEnd || null,
      completedAt: editStatus === 'done' ? new Date().toISOString() : project.completedAt,
    })
    if (r.ok) {
      message.success('项目信息已更新')
      setEditing(false)
      await loadProjects()
    }
    setSaving(false)
  }

  const handleOpenInfo = async () => {
    if (!currentProjectId) return
    const r = await window.api.file.read({ projectId: currentProjectId, filePath: 'info.md' })
    if (r.ok) openFile('info.md', `${project.name} - 基本信息`, r.data)
  }

  const statusOption = STATUS_OPTIONS.find((s) => s.value === project.status)

  return (
    <div style={{
      flex: 1, padding: 24, overflow: 'auto',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
    }}>
      <div style={{ maxWidth: 600, width: '100%' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {STATUS_ICONS[project.status]}
            <div>
              {editing ? (
                <Input value={editName} onChange={(e) => setEditName(e.target.value)}
                  style={{ fontSize: 20, fontWeight: 600, width: 300 }} autoFocus />
              ) : (
                <h1 style={{ margin: 0, color: '#cccccc', fontSize: 22 }}>{project.name}</h1>
              )}
              {group && <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>📂 {group.name}</div>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {editing ? (
              <>
                <Button size="small" icon={<SaveOutlined />} type="primary" loading={saving} onClick={handleSave}>保存</Button>
                <Button size="small" icon={<CloseOutlined />} onClick={() => setEditing(false)}>取消</Button>
              </>
            ) : (
              <>
                <Button size="small" icon={<EditOutlined />} onClick={handleEdit}>编辑</Button>
                <Button size="small" onClick={handleOpenInfo}>查看 info.md</Button>
              </>
            )}
          </div>
        </div>

        {/* Status tag */}
        {editing ? (
          <Select value={editStatus} onChange={setEditStatus} style={{ width: 120, marginBottom: 16 }}
            options={STATUS_OPTIONS.map((s) => ({ value: s.value, label: s.label }))} />
        ) : (
          <Tag color={statusOption?.color} style={{ marginBottom: 16, fontSize: 13 }}>
            {statusOption?.label || project.status}
          </Tag>
        )}

        {/* Details */}
        <Descriptions column={2} size="small" bordered
          styles={{
            label: { color: '#888', fontSize: 12, backgroundColor: '#1e1e1e' },
            content: { color: '#ccc', fontSize: 13, backgroundColor: '#252526' },
          }}
        >
          <Descriptions.Item label="开始日期" span={1}>
            {editing
              ? <Input size="small" value={editStart} onChange={(e) => setEditStart(e.target.value)} placeholder="YYYY-MM-DD" />
              : (project.startDate || '未设置')
            }
          </Descriptions.Item>
          <Descriptions.Item label="截止日期" span={1}>
            {editing
              ? <Input size="small" value={editEnd} onChange={(e) => setEditEnd(e.target.value)} placeholder="YYYY-MM-DD" />
              : (project.endDate || '未设置')
            }
          </Descriptions.Item>
          <Descriptions.Item label="创建时间" span={1}>
            {new Date(project.createdAt).toLocaleDateString('zh-CN')}
          </Descriptions.Item>
          <Descriptions.Item label="最后更新" span={1}>
            {new Date(project.updatedAt).toLocaleDateString('zh-CN')}
          </Descriptions.Item>
          {project.completedAt && (
            <Descriptions.Item label="完成时间" span={2}>
              {new Date(project.completedAt).toLocaleString('zh-CN')}
            </Descriptions.Item>
          )}
          <Descriptions.Item label="项目描述" span={2}>
            {editing
              ? <TextArea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} rows={3}
                placeholder="输入项目描述..." />
              : (project.description || '暂无描述')
            }
          </Descriptions.Item>
        </Descriptions>

        {/* Files quick access */}
        <div style={{
          marginTop: 20, padding: 16, backgroundColor: '#252526',
          borderRadius: 6, border: '1px solid #3e3e3e',
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#ccc', marginBottom: 8 }}>
            📄 快速操作
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button size="small" onClick={handleOpenInfo}>📋 查看 info.md</Button>
            <Button size="small" onClick={async () => {
              const files = await window.api.file.list(currentProjectId!)
              if (files.ok && files.data.length > 0) {
                const firstMd = files.data.find((f: string) => f.endsWith('.md'))
                if (firstMd) {
                  const r = await window.api.file.read({ projectId: currentProjectId!, filePath: firstMd })
                  if (r.ok) openFile(firstMd, firstMd.split('/').pop() || firstMd, r.data)
                }
              }
            }}>📝 打开第一个文件</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
