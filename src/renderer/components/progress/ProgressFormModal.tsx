import { useState, useEffect } from 'react'
import { Modal, Input, Select, InputNumber } from 'antd'
import type { ProgressStatus, ProgressPriority, CreateProgressDTO, UpdateProgressDTO } from '../../types/progress'

const { TextArea } = Input

interface CreateProps {
  open: boolean
  projectId: string
  onClose: () => void
  onSubmit: (dto: CreateProgressDTO) => Promise<void>
}

interface EditProps {
  open: boolean
  initialData: {
    id: string
    title: string
    status: ProgressStatus
    priority: ProgressPriority
    notes: string
    estimatedHours: number | null
  }
  onClose: () => void
  onSubmit: (id: string, dto: UpdateProgressDTO) => Promise<void>
}

type Props = CreateProps | EditProps

export default function ProgressFormModal(props: Props): JSX.Element {
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<ProgressStatus>('todo')
  const [priority, setPriority] = useState<ProgressPriority>('medium')
  const [notes, setNotes] = useState('')
  const [estimatedHours, setEstimatedHours] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  const isEdit = 'initialData' in props

  useEffect(() => {
    if (props.open) {
      if (isEdit) {
        setTitle(props.initialData.title)
        setStatus(props.initialData.status)
        setPriority(props.initialData.priority)
        setNotes(props.initialData.notes)
        setEstimatedHours(props.initialData.estimatedHours)
      } else {
        setTitle('')
        setStatus('todo')
        setPriority('medium')
        setNotes('')
        setEstimatedHours(null)
      }
    }
  }, [props.open])

  const handleOk = async () => {
    const trimmed = title.trim()
    if (!trimmed) return
    setLoading(true)
    try {
      if (isEdit) {
        await props.onSubmit(props.initialData.id, {
          title: trimmed,
          status,
          priority,
          notes,
          estimatedHours: estimatedHours ?? undefined,
        })
      } else {
        await props.onSubmit({
          projectId: props.projectId,
          title: trimmed,
          status,
          priority,
          notes,
          estimatedHours: estimatedHours ?? undefined,
        })
      }
      props.onClose()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title={isEdit ? '编辑进度' : '添加进度'}
      open={props.open}
      onOk={handleOk}
      onCancel={props.onClose}
      confirmLoading={loading}
      okText={isEdit ? '保存' : '添加'}
      cancelText="取消"
      destroyOnClose
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
        <Input
          placeholder="任务标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onPressEnter={handleOk}
          autoFocus
        />

        <div style={{ display: 'flex', gap: 8 }}>
          <Select
            value={status}
            onChange={setStatus}
            style={{ flex: 1 }}
            options={[
              { value: 'todo', label: '📋 待开始' },
              { value: 'doing', label: '🔄 进行中' },
              { value: 'done', label: '✅ 已完成' },
              { value: 'blocked', label: '🚫 已阻塞' },
            ]}
          />
          <Select
            value={priority}
            onChange={setPriority}
            style={{ flex: 1 }}
            options={[
              { value: 'low', label: '低优先级' },
              { value: 'medium', label: '中优先级' },
              { value: 'high', label: '高优先级' },
            ]}
          />
        </div>

        <InputNumber
          placeholder="预估工时（小时）"
          value={estimatedHours}
          onChange={setEstimatedHours}
          min={0}
          step={0.5}
          style={{ width: '100%' }}
        />

        <TextArea
          placeholder="备注（可选）"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
        />
      </div>
    </Modal>
  )
}
