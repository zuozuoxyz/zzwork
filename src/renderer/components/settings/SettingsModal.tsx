import { useState, useEffect } from 'react'
import { Modal, Input, Button, message, Descriptions } from 'antd'
import { KeyOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import { useUIStore } from '../../stores/ui.store'

interface Props {
  open: boolean
  onClose: () => void
}

export default function SettingsModal({ open, onClose }: Props): JSX.Element {
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [hasKey, setHasKey] = useState(false)
  const [checking, setChecking] = useState(true)

  // Check for existing API key on open
  useEffect(() => {
    if (!open) return
    setChecking(true)
    window.api.settings.get('has_api_key').then((result) => {
      if (result.ok) {
        setHasKey(result.data === 'true')
      }
      setChecking(false)
    })
  }, [open])

  const handleSave = async () => {
    if (!apiKey.trim()) return
    setSaving(true)
    try {
      const result = await window.api.settings.set('anthropic_api_key', apiKey.trim())
      if (result.ok) {
        setHasKey(true)
        setApiKey('')
        message.success('API Key 已保存')
      } else {
        message.error(result.error?.message || '保存失败')
      }
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    await window.api.settings.set('anthropic_api_key', '')
    setHasKey(false)
    message.success('API Key 已清除')
  }

  return (
    <Modal
      title="设置"
      open={open}
      onCancel={onClose}
      footer={null}
      width={480}
      destroyOnClose
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 8 }}>
        {/* API Key section */}
        <div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
          }}>
            <KeyOutlined />
            <span style={{ fontWeight: 600, color: '#cccccc' }}>Anthropic API Key</span>
            {!checking && (
              hasKey
                ? <CheckCircleOutlined style={{ color: '#4d9e4d' }} />
                : <CloseCircleOutlined style={{ color: '#d16969' }} />
            )}
          </div>

          <Descriptions
            size="small"
            column={1}
            style={{ marginBottom: 12 }}
            styles={{ label: { color: '#888' }, content: { color: '#aaa', fontSize: 12 } }}
            items={[
              { key: '获取 Key', label: '获取 Key', children: '前往 console.anthropic.com 创建 API Key' },
              { key: '存储', label: '存储位置', children: '系统密钥链（Keychain / Credential Manager）' },
              { key: '模型', label: '默认模型', children: 'claude-sonnet-4-20250514' },
            ]}
          />

          <div style={{ display: 'flex', gap: 8 }}>
            <Input.Password
              placeholder={hasKey ? '●●●●●●●●（已设置）' : '输入 API Key (sk-ant-...)'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onPressEnter={handleSave}
            />
            <Button type="primary" onClick={handleSave} loading={saving} disabled={!apiKey.trim()}>
              保存
            </Button>
            {hasKey && (
              <Button danger onClick={handleClear}>
                清除
              </Button>
            )}
          </div>
        </div>

        {/* About */}
        <div style={{
          borderTop: '1px solid #3e3e3e',
          paddingTop: 12,
          fontSize: 12,
          color: '#666',
          textAlign: 'center',
        }}>
          zzwork v0.2.0 · Phase 2 AI Integration
        </div>
      </div>
    </Modal>
  )
}
