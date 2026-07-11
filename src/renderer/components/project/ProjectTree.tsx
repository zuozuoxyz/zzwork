import { useEffect, useState } from 'react'
import { Tree, Dropdown, message } from 'antd'
import {
  FolderOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  DeleteOutlined,
  InboxOutlined,
} from '@ant-design/icons'
import type { MenuProps } from 'antd'
import { useProjectStore } from '../../stores/project.store'
import { useProgressStore } from '../../stores/progress.store'
import ProjectCreateModal from './ProjectCreateModal'

export default function ProjectTree(): JSX.Element {
  const { projects, currentProjectId, loadProjects, setCurrentProject, deleteProject } =
    useProjectStore()
  const loadByProject = useProgressStore((s) => s.loadByProject)
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  const handleSelect = (selectedKeys: React.Key[]) => {
    const id = selectedKeys[0] as string | undefined
    if (id) {
      setCurrentProject(id)
      loadByProject(id)
    }
  }

  const contextMenuItems: MenuProps['items'] = [
    { key: 'delete', label: '删除项目', icon: <DeleteOutlined />, danger: true },
  ]

  const treeData = projects
    .filter((p) => p.status === 'active')
    .map((p) => ({
      key: p.id,
      title: (
        <Dropdown menu={{
          items: contextMenuItems,
          onClick: async ({ key }) => {
            if (key === 'delete') {
              await deleteProject(p.id)
              message.success(`已删除项目 "${p.name}"`)
            }
          }
        }} trigger={['contextMenu']}>
          <span style={{ fontSize: 13 }}>{p.name}</span>
        </Dropdown>
      ),
      icon: currentProjectId === p.id
        ? <FolderOpenOutlined style={{ color: '#dcb67a' }} />
        : <FolderOutlined style={{ color: '#dcb67a' }} />,
      isLeaf: true,
    }))

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px 8px',
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: '#999',
        }}>
          项目
        </span>
        <PlusOutlined
          style={{ cursor: 'pointer', color: '#999', fontSize: 14 }}
          onClick={() => setModalOpen(true)}
        />
      </div>

      {treeData.length === 0 ? (
        <div style={{
          padding: '16px 12px',
          color: '#666',
          fontSize: 12,
          textAlign: 'center',
        }}>
          <InboxOutlined style={{ fontSize: 20, marginBottom: 8, display: 'block' }} />
          暂无项目，点击 + 创建
        </div>
      ) : (
        <Tree
          showIcon
          treeData={treeData}
          selectedKeys={currentProjectId ? [currentProjectId] : []}
          onSelect={handleSelect}
          blockNode
          style={{ padding: '0 4px' }}
        />
      )}

      <ProjectCreateModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
      />
    </div>
  )
}
