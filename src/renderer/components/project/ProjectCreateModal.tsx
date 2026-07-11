import { useState, useEffect } from 'react'
import { Modal, Input, Select, message } from 'antd'
import { useProjectStore } from '../../stores/project.store'

const { TextArea } = Input

interface Props {
  open: boolean
  onClose: () => void
}

export default function ProjectCreateModal({ open, onClose }: Props): JSX.Element {
  const [name, setName] = useState('')
  const [groupId, setGroupId] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [loading, setLoading] = useState(false)

  const createProject = useProjectStore((s) => s.createProject)
  const groups = useProjectStore((s) => s.groups)
  const loadGroups = useProjectStore((s) => s.loadGroups)

  useEffect(() => {
    if (open) loadGroups()
  }, [open, loadGroups])

  const handleOk = async () => {
    const trimmed = name.trim()
    if (!trimmed) { message.warning('请输入项目名称'); return }
    setLoading(true)
    try {
      await createProject({
        name: trimmed,
        groupId: groupId || undefined,
        description,
        startDate: startDate || null,
        endDate: endDate || null,
      })
      message.success(`项目 "${trimmed}" 创建成功`)
      setName(''); setGroupId(null); setDescription(''); setStartDate(''); setEndDate('')
      onClose()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal title="创建新项目" open={open} onOk={handleOk} onCancel={() => { setName(''); onClose() }}
      confirmLoading={loading} okText="创建" cancelText="取消" destroyOnClose width={420}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
        <Input placeholder="项目名称" value={name} onChange={(e) => setName(e.target.value)}
          onPressEnter={handleOk} autoFocus />
        <Select placeholder="所属组（可选）" value={groupId} onChange={setGroupId} allowClear
          options={groups.map((g) => ({ value: g.id, label: g.name }))} />
        <TextArea placeholder="项目描述" value={description}
          onChange={(e) => setDescription(e.target.value)} rows={2} />
        <div style={{ display: 'flex', gap: 8 }}>
          <Input placeholder="开始日期 (如 2026-07-01)" value={startDate}
            onChange={(e) => setStartDate(e.target.value)} style={{ flex: 1 }} />
          <Input placeholder="截止日期 (如 2026-12-31)" value={endDate}
            onChange={(e) => setEndDate(e.target.value)} style={{ flex: 1 }} />
        </div>
      </div>
    </Modal>
  )
}
