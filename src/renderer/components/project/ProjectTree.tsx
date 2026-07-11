import { useEffect, useState } from 'react'
import { Tree, Dropdown, Input, message } from 'antd'
import {
  FolderOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  DeleteOutlined,
  InboxOutlined,
  AppstoreAddOutlined,
  FileAddOutlined,
  FolderAddOutlined,
} from '@ant-design/icons'
import type { MenuProps } from 'antd'
import { useProjectStore } from '../../stores/project.store'
import { useProgressStore } from '../../stores/progress.store'
import ProjectCreateModal from './ProjectCreateModal'

export default function ProjectTree(): JSX.Element {
  const { projects, groups, currentProjectId, loadProjects, loadGroups, setCurrentProject, deleteProject, createGroup, deleteGroup } =
    useProjectStore()
  const loadByProject = useProgressStore((s) => s.loadByProject)
  const [modalOpen, setModalOpen] = useState(false)
  const [preselectedGroupId, setPreselectedGroupId] = useState<string | null>(null)
  const [addingGroup, setAddingGroup] = useState(false)
  const [groupName, setGroupName] = useState('')

  useEffect(() => {
    loadProjects()
    loadGroups()
  }, [loadProjects, loadGroups])

  const handleSelect = (selectedKeys: React.Key[]) => {
    const id = selectedKeys[0] as string | undefined
    if (id && !id.startsWith('group-')) {
      setCurrentProject(id)
      loadByProject(id)
    }
  }

  const handleAddGroup = async () => {
    const name = groupName.trim()
    if (!name) return
    await createGroup({ name })
    setGroupName('')
    setAddingGroup(false)
  }

  // Build tree: groups contain projects
  const treeData: any[] = []

  // Groups with their projects
  for (const group of groups) {
    const groupProjects = projects.filter((p) => p.groupId === group.id && p.status !== 'archived')
    treeData.push({
      key: `group-${group.id}`,
      title: (
        <Dropdown menu={{
          items: [
            { key: 'add', label: '添加项目到此组', icon: <PlusOutlined /> },
            { type: 'divider' as const },
            { key: 'delete', label: '删除组', icon: <DeleteOutlined />, danger: true },
          ],
          onClick: async ({ key }) => {
            if (key === 'add') {
              setPreselectedGroupId(group.id)
              setModalOpen(true)
            }
            if (key === 'delete') {
              await deleteGroup(group.id)
              message.success(`已删除组 "${group.name}"`)
            }
          }
        }} trigger={['contextMenu']}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#888' }}>{group.name}</span>
        </Dropdown>
      ),
      icon: <FolderOutlined style={{ color: '#6a9ecd' }} />,
      selectable: false,
      children: groupProjects.map((p) => projectToNode(p)),
    })
  }

  // Ungrouped projects
  const ungrouped = projects.filter((p) => !p.groupId && p.status !== 'archived')
  for (const p of ungrouped) {
    treeData.push(projectToNode(p))
  }

  function projectToNode(p: typeof projects[0]) {
    return {
      key: p.id,
      title: (
        <Dropdown menu={{
          items: [
            { key: 'delete', label: '删除项目', icon: <DeleteOutlined />, danger: true },
          ],
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
    }
  }

  const isEmpty = treeData.length === 0

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
        <div style={{ display: 'flex', gap: 4 }}>
          <AppstoreAddOutlined
            style={{ cursor: 'pointer', color: '#999', fontSize: 14 }}
            onClick={() => setAddingGroup(!addingGroup)}
            title="添加组"
          />
          <PlusOutlined
            style={{ cursor: 'pointer', color: '#999', fontSize: 14 }}
            onClick={() => setModalOpen(true)}
            title="添加项目"
          />
        </div>
      </div>

      {/* Add group input */}
      {addingGroup && (
        <div style={{ padding: '0 12px 8px', display: 'flex', gap: 4 }}>
          <Input
            size="small"
            placeholder="组名称"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            onPressEnter={handleAddGroup}
            autoFocus
          />
        </div>
      )}

      {isEmpty ? (
        <div style={{
          padding: '16px 12px',
          color: '#666',
          fontSize: 12,
          textAlign: 'center',
        }}>
          <InboxOutlined style={{ fontSize: 20, marginBottom: 8, display: 'block' }} />
          点击 <AppstoreAddOutlined /> 创建组，再右键组添加项目
        </div>
      ) : (
        <Tree
          showIcon
          treeData={treeData}
          selectedKeys={currentProjectId ? [currentProjectId] : []}
          onSelect={handleSelect}
          blockNode
          defaultExpandAll
          style={{ padding: '0 4px' }}
        />
      )}

      <ProjectCreateModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setPreselectedGroupId(null) }}
        preselectedGroupId={preselectedGroupId}
      />
    </div>
  )
}