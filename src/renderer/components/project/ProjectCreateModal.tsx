import { useState } from 'react'
import { Modal, Input, message } from 'antd'
import { useProjectStore } from '../../stores/project.store'

interface Props {
  open: boolean
  onClose: () => void
}

export default function ProjectCreateModal({ open, onClose }: Props): JSX.Element {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const createProject = useProjectStore((s) => s.createProject)

  const handleOk = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      message.warning('请输入项目名称')
      return
    }
    setLoading(true)
    try {
      await createProject({ name: trimmed })
      message.success(`项目 "${trimmed}" 创建成功`)
      setName('')
      onClose()
    } catch {
      // Error handled by IPC layer
    } finally {
      setLoading(false)
    }
  }

  const handleCancel = () => {
    setName('')
    onClose()
  }

  return (
    <Modal
      title="创建新项目"
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      confirmLoading={loading}
      okText="创建"
      cancelText="取消"
      destroyOnClose
    >
      <Input
        placeholder="输入项目名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onPressEnter={handleOk}
        autoFocus
        style={{ marginTop: 8 }}
      />
    </Modal>
  )
}
