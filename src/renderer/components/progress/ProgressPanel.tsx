import { useState } from 'react'
import { Button } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { useProgressStore } from '../../stores/progress.store'
import { useProjectStore } from '../../stores/project.store'
import ProgressKanban from './ProgressKanban'
import ProgressFormModal from './ProgressFormModal'
import type { ProgressItem, ProgressStatus, CreateProgressDTO, UpdateProgressDTO } from '../../types/progress'

export default function ProgressPanel(): JSX.Element {
  const { items, add, update, remove } = useProgressStore()
  const currentProjectId = useProjectStore((s) => s.currentProjectId)

  const [modalOpen, setModalOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<ProgressItem | null>(null)

  const handleAdd = async (dto: CreateProgressDTO) => {
    await add(dto)
  }

  const handleEdit = async (_id: string, dto: UpdateProgressDTO) => {
    if (!editingItem) return
    await update(editingItem.id, dto)
    setEditingItem(null)
  }

  const handleDelete = async (id: string) => {
    await remove(id)
  }

  const handleStatusChange = async (id: string, status: ProgressStatus) => {
    await update(id, { status })
  }

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
          进度 {items.length > 0 && `(${items.length})`}
        </span>
        <Button
          type="text"
          size="small"
          icon={<PlusOutlined />}
          disabled={!currentProjectId}
          onClick={() => setModalOpen(true)}
          style={{ color: '#999', fontSize: 12 }}
        >
          添加
        </Button>
      </div>

      {!currentProjectId ? (
        <div style={{ padding: '16px 12px', color: '#666', fontSize: 12, textAlign: 'center' }}>
          请先选择一个项目
        </div>
      ) : items.length === 0 ? (
        <div style={{ padding: '16px 12px', color: '#666', fontSize: 12, textAlign: 'center' }}>
          暂无进度，点击添加
        </div>
      ) : (
        <ProgressKanban
          items={items}
          onEdit={(item) => { setEditingItem(item); setModalOpen(true) }}
          onDelete={handleDelete}
          onStatusChange={handleStatusChange}
        />
      )}

      {/* Create modal */}
      {!editingItem && currentProjectId && (
        <ProgressFormModal
          open={modalOpen}
          projectId={currentProjectId}
          onClose={() => setModalOpen(false)}
          onSubmit={handleAdd}
        />
      )}

      {/* Edit modal */}
      {editingItem && (
        <ProgressFormModal
          open={modalOpen}
          initialData={{
            id: editingItem.id,
            title: editingItem.title,
            status: editingItem.status,
            priority: editingItem.priority,
            notes: editingItem.notes,
            estimatedHours: editingItem.estimatedHours,
          }}
          onClose={() => { setModalOpen(false); setEditingItem(null) }}
          onSubmit={handleEdit}
        />
      )}
    </div>
  )
}
