import { useState, useEffect } from 'react'
import { Modal, Button, List, Tag, Popconfirm, Select, Input, message, Space } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, StarOutlined, StarFilled } from '@ant-design/icons'
import type { ModelConfig, CreateModelDTO, UpdateModelDTO } from '../../types/model'

interface Props {
  open: boolean
  onClose: () => void
}

interface ModelForm {
  name: string
  type: 'anthropic' | 'openai_compatible'
  baseUrl: string
  apiKey: string
  modelId: string
}

const EMPTY_FORM: ModelForm = {
  name: '',
  type: 'anthropic',
  baseUrl: '',
  apiKey: '',
  modelId: '',
}

const MODEL_TYPE_OPTIONS = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai_compatible', label: 'OpenAI Compatible' },
]

export default function SettingsModal({ open, onClose }: Props): JSX.Element {
  const [models, setModels] = useState<ModelConfig[]>([])
  const [editingModel, setEditingModel] = useState<ModelConfig | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<ModelForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const loadModels = async () => {
    const result = await window.api.model.list()
    if (result.ok) {
      setModels(result.data)
    }
  }

  useEffect(() => {
    if (open) loadModels()
  }, [open])

  const openAddForm = () => {
    setEditingModel(null)
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }

  const openEditForm = (model: ModelConfig) => {
    setEditingModel(model)
    setForm({
      name: model.name,
      type: model.type,
      baseUrl: model.baseUrl,
      apiKey: '',
      modelId: model.modelId,
    })
    setFormOpen(true)
  }

  const handleSave = async () => {
    if (!form.name.trim() || !form.baseUrl.trim() || !form.modelId.trim()) {
      message.warning('请填写所有必填字段（名称、URL、Model ID）')
      return
    }

    setSaving(true)
    try {
      if (editingModel) {
        const dto: UpdateModelDTO = {
          name: form.name.trim(),
          type: form.type,
          baseUrl: form.baseUrl.trim(),
          modelId: form.modelId.trim(),
        }
        if (form.apiKey.trim()) {
          dto.apiKey = form.apiKey.trim()
        }
        const result = await window.api.model.update(editingModel.id, dto)
        if (result.ok) {
          message.success('模型已更新')
          setFormOpen(false)
          await loadModels()
        } else {
          message.error(result.error?.message || '更新失败')
        }
      } else {
        if (!form.apiKey.trim()) {
          message.warning('请填写 API Key')
          return
        }
        const dto: CreateModelDTO = {
          name: form.name.trim(),
          type: form.type,
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey.trim(),
          modelId: form.modelId.trim(),
          isDefault: models.length === 0, // first model is default
        }
        const result = await window.api.model.create(dto)
        if (result.ok) {
          message.success('模型已添加')
          setFormOpen(false)
          await loadModels()
        } else {
          message.error(result.error?.message || '添加失败')
        }
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (models.length <= 1) {
      message.warning('不能删除最后一个模型')
      return
    }
    const result = await window.api.model.delete(id)
    if (result.ok) {
      message.success('模型已删除')
      await loadModels()
    } else {
      message.error(result.error?.message || '删除失败')
    }
  }

  const handleSetDefault = async (id: string) => {
    const result = await window.api.model.setDefault(id)
    if (result.ok) {
      message.success('已设为默认模型')
      await loadModels()
    } else {
      message.error(result.error?.message || '设置失败')
    }
  }

  return (
    <Modal
      title="模型管理"
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      destroyOnClose
    >
      <div style={{ marginTop: 8 }}>
        <List
          dataSource={models}
          locale={{ emptyText: '暂无模型，请添加' }}
          renderItem={(model) => (
            <List.Item
              actions={[
                <Button
                  key="default"
                  type="text"
                  size="small"
                  icon={model.isDefault ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
                  onClick={() => handleSetDefault(model.id)}
                  title={model.isDefault ? '当前默认' : '设为默认'}
                />,
                <Button
                  key="edit"
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => openEditForm(model)}
                />,
                <Popconfirm
                  key="delete"
                  title="确定删除此模型？"
                  description="删除后不可恢复"
                  onConfirm={() => handleDelete(model.id)}
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                >
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                  />
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space size={4}>
                    {model.isDefault && (
                      <Tag color="gold" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>默认</Tag>
                    )}
                    <span style={{ color: '#ccc' }}>{model.name}</span>
                    <Tag color="blue" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>
                      {model.type === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                    </Tag>
                  </Space>
                }
                description={
                  <div style={{ fontSize: 11, color: '#888' }}>
                    <div>{model.baseUrl}</div>
                    <div>Model ID: {model.modelId}</div>
                  </div>
                }
              />
            </List.Item>
          )}
        />

        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <Button type="dashed" icon={<PlusOutlined />} onClick={openAddForm} block>
            添加模型
          </Button>
        </div>
      </div>

      {/* Add/Edit Form Modal */}
      <Modal
        title={editingModel ? '编辑模型' : '添加模型'}
        open={formOpen}
        onCancel={() => setFormOpen(false)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
          <div>
            <div style={{ marginBottom: 4, color: '#ccc', fontSize: 12 }}>名称 *</div>
            <Input
              placeholder="例如: Claude Sonnet"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          <div>
            <div style={{ marginBottom: 4, color: '#ccc', fontSize: 12 }}>类型</div>
            <Select
              value={form.type}
              onChange={(value) => setForm({ ...form, type: value })}
              options={MODEL_TYPE_OPTIONS}
              style={{ width: '100%' }}
            />
          </div>

          <div>
            <div style={{ marginBottom: 4, color: '#ccc', fontSize: 12 }}>Base URL *</div>
            <Input
              placeholder={form.type === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'}
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
          </div>

          <div>
            <div style={{ marginBottom: 4, color: '#ccc', fontSize: 12 }}>API Key {editingModel ? '(留空不修改)' : '*'}</div>
            <Input.Password
              placeholder="sk-..."
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </div>

          <div>
            <div style={{ marginBottom: 4, color: '#ccc', fontSize: 12 }}>Model ID *</div>
            <Input
              placeholder="例如: claude-sonnet-4-20250514"
              value={form.modelId}
              onChange={(e) => setForm({ ...form, modelId: e.target.value })}
            />
          </div>
        </div>
      </Modal>
    </Modal>
  )
}
