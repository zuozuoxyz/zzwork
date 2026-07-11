import { useEffect, useState } from 'react'
import { Tree, Dropdown, Input, message, Modal } from 'antd'
import {
  FileOutlined, FileTextOutlined, FolderOutlined, FolderOpenOutlined,
  FileAddOutlined, FolderAddOutlined, DeleteOutlined, ReloadOutlined,
} from '@ant-design/icons'
import type { MenuProps } from 'antd'
import { useProjectStore } from '../../stores/project.store'
import { useEditorStore } from '../../stores/editor.store'

interface FileNode {
  name: string
  path: string
  isDir: boolean
  children?: FileNode[]
}

function parseFileList(files: string[]): FileNode[] {
  const root: FileNode[] = []
  for (const f of files) {
    const parts = f.split('/')
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1
      const name = parts[i]
      let node = current.find((n) => n.name === name)
      if (!node) {
        node = { name, path: parts.slice(0, i + 1).join('/'), isDir: !isLast, children: [] }
        current.push(node)
      }
      if (isLast) node.isDir = false
      current = node.children!
    }
  }
  return sortNodes(root)
}

function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function nodesToTreeData(nodes: FileNode[]): any[] {
  return nodes.map((n) => ({
    key: n.path,
    title: n.name,
    icon: n.isDir ? <FolderOutlined style={{ color: '#dcb67a' }} /> : <FileTextOutlined style={{ color: '#999' }} />,
    isLeaf: !n.isDir,
    children: n.isDir ? nodesToTreeData(n.children || []) : undefined,
    data: n,
  }))
}

export default function FileTree(): JSX.Element {
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const openFile = useEditorStore((s) => s.openFile)
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [newItem, setNewItem] = useState<{ parentPath: string; isDir: boolean } | null>(null)
  const [newName, setNewName] = useState('')

  const loadFiles = async () => {
    if (!currentProjectId) { setFiles([]); return }
    setLoading(true)
    const r = await window.api.file.list(currentProjectId)
    if (r.ok) setFiles(r.data)
    setLoading(false)
  }

  useEffect(() => { loadFiles() }, [currentProjectId])

  const handleCreate = async () => {
    if (!newItem || !newName.trim() || !currentProjectId) return
    const fullPath = newItem.parentPath ? `${newItem.parentPath}/${newName.trim()}` : newName.trim()
    if (newItem.isDir) {
      // Create a placeholder file to simulate directory
      await window.api.file.create({ projectId: currentProjectId, filePath: `${fullPath}/.gitkeep`, content: '' })
    } else {
      await window.api.file.create({ projectId: currentProjectId, filePath: fullPath, content: '' })
    }
    setNewItem(null)
    setNewName('')
    await loadFiles()
  }

  const handleDelete = async (filePath: string) => {
    if (!currentProjectId) return
    await window.api.file.delete({ projectId: currentProjectId, filePath })
    message.success(`已删除 ${filePath}`)
    await loadFiles()
  }

  const handleOpenFile = async (filePath: string) => {
    if (!currentProjectId) return
    const r = await window.api.file.read({ projectId: currentProjectId, filePath })
    if (r.ok) {
      const name = filePath.split('/').pop() || filePath
      openFile(filePath, name, r.data)
    }
  }

  const treeNodes = parseFileList(files)
  const treeData = nodesToTreeData(treeNodes)

  if (!currentProjectId) {
    return (
      <div style={{ padding: '12px', color: '#666', fontSize: 12, textAlign: 'center' }}>
        选择项目查看文件
      </div>
    )
  }

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 12px 8px',
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#999' }}>
          文件
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <FileAddOutlined style={{ cursor: 'pointer', color: '#999', fontSize: 14 }}
            onClick={() => { setNewItem({ parentPath: '', isDir: false }); setNewName('') }}
            title="新建文件" />
          <FolderAddOutlined style={{ cursor: 'pointer', color: '#999', fontSize: 14 }}
            onClick={() => { setNewItem({ parentPath: '', isDir: true }); setNewName('') }}
            title="新建文件夹" />
          <ReloadOutlined style={{ cursor: 'pointer', color: '#999', fontSize: 12 }}
            onClick={loadFiles} title="刷新" />
        </div>
      </div>

      {/* New file/folder input */}
      {newItem && (
        <div style={{ padding: '0 12px 8px', display: 'flex', gap: 4 }}>
          <Input size="small"
            placeholder={newItem.isDir ? '文件夹名称' : '文件名称'}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onPressEnter={handleCreate}
            onBlur={() => { if (!newName.trim()) setNewItem(null) }}
            autoFocus
          />
        </div>
      )}

      {treeData.length === 0 && !loading ? (
        <div style={{ padding: '12px', color: '#666', fontSize: 12, textAlign: 'center' }}>
          空项目，点击上方图标新建文件
        </div>
      ) : (
        <Tree
          showIcon
          treeData={treeData}
          onSelect={(keys) => {
            const key = keys[0] as string
            if (key && !key.endsWith('/.gitkeep') && !treeNodes.find((n) => n.path === key && n.isDir)) {
              handleOpenFile(key)
            }
          }}
          onRightClick={({ node }) => {
            const data = (node as any).data as FileNode
            if (!data) return
            const items: MenuProps['items'] = []
            if (data.isDir) {
              items.push(
                { key: 'newfile', label: '新建文件', icon: <FileAddOutlined />, onClick: () => setNewItem({ parentPath: data.path, isDir: false }) },
                { key: 'newdir', label: '新建文件夹', icon: <FolderAddOutlined />, onClick: () => setNewItem({ parentPath: data.path, isDir: true }) },
                { type: 'divider' as const },
              )
            }
            items.push({ key: 'delete', label: '删除', icon: <DeleteOutlined />, danger: true,
              onClick: () => {
                Modal.confirm({
                  title: `删除 ${data.name}?`,
                  content: data.isDir ? '将删除该文件夹及其所有内容' : '文件将被永久删除',
                  okText: '删除', okType: 'danger', cancelText: '取消',
                  onOk: () => handleDelete(data.path),
                })
              }
            })
            // We can't use Dropdown easily on Tree nodes, so use a custom approach
            // For now, the right-click creates new items in directories
          }}
          blockNode
          defaultExpandAll
          style={{ padding: '0 4px', fontSize: 12 }}
        />
      )}
    </div>
  )
}
