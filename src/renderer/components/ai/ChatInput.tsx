import { useState, useRef, useEffect } from 'react'
import { Input, Button, Tag, Select } from 'antd'
import { SendOutlined, HighlightOutlined } from '@ant-design/icons'
import { useConversationStore } from '../../stores/conversation.store'
import { useProjectStore } from '../../stores/project.store'
import type { ModelConfig } from '../../types/model'

const { TextArea } = Input

const CAPABILITIES = [
  { key: 'analyze', label: '/analyze 分析进度', icon: '📊' },
  { key: 'report', label: '/report 生成周报', icon: '📄' },
  { key: 'decompose', label: '/decompose 拆解任务', icon: '🔨' },
]

export default function ChatInput(): JSX.Element {
  const [input, setInput] = useState('')
  const [capability, setCapability] = useState<string | undefined>()
  const [selectedText, setSelectedText] = useState<string | undefined>()
  const [models, setModels] = useState<ModelConfig[]>([])
  const textAreaRef = useRef<any>(null)

  const sendMessage = useConversationStore((s) => s.sendMessage)
  const isStreaming = useConversationStore((s) => s.isStreaming)
  const currentModelId = useConversationStore((s) => s.currentModelId)
  const setModelId = useConversationStore((s) => s.setModelId)
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const projects = useProjectStore((s) => s.projects)
  const currentProject = projects.find((p) => p.id === currentProjectId)

  // Load models for the selector
  useEffect(() => {
    window.api.model.list().then((r) => {
      if (r.ok) setModels(r.data)
    })
  }, [])

  // Listen for text selection in editor
  useEffect(() => {
    const handleSelection = () => {
      const selection = window.getSelection()
      if (selection && selection.toString().trim()) {
        setSelectedText(selection.toString().trim())
      }
    }
    document.addEventListener('mouseup', handleSelection)
    return () => document.removeEventListener('mouseup', handleSelection)
  }, [])

  const handleSend = async () => {
    const trimmed = input.trim()
    if (!trimmed || !currentProjectId || isStreaming) return

    setInput('')

    await sendMessage(
      currentProjectId,
      trimmed,
      capability,
      selectedText,
    )

    setCapability(undefined)
    setSelectedText(undefined)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const toggleCapability = (key: string) => {
    setCapability((prev) => (prev === key ? undefined : key))
  }

  return (
    <div style={{
      padding: '8px 12px 12px',
      borderTop: '1px solid #3e3e3e',
      backgroundColor: '#1e1e1e',
    }}>
      {/* Model selector */}
      <Select
        value={currentModelId || undefined}
        onChange={setModelId}
        size="small"
        style={{ width: 180, marginBottom: 8 }}
        options={models.map((m) => ({
          value: m.id,
          label: `${m.isDefault ? '● ' : ''}${m.name}`,
        }))}
        placeholder="选择模型"
      />

      {/* Capability tags */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        {CAPABILITIES.map((c) => (
          <Tag
            key={c.key}
            color={capability === c.key ? 'blue' : undefined}
            style={{
              cursor: 'pointer',
              fontSize: 11,
              margin: 0,
              opacity: capability && capability !== c.key ? 0.5 : 1,
            }}
            onClick={() => toggleCapability(c.key)}
          >
            {c.icon} {c.label}
          </Tag>
        ))}
      </div>

      {/* Selected text indicator */}
      {selectedText && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          marginBottom: 6,
          padding: '4px 8px',
          backgroundColor: '#2d2d2d',
          borderRadius: 4,
          fontSize: 11,
          color: '#999',
        }}>
          <HighlightOutlined />
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            已选中: {selectedText.substring(0, 60)}
          </span>
        </div>
      )}

      {/* Input area */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <TextArea
          ref={textAreaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            !currentProjectId
              ? '请先选择一个项目'
              : '输入消息，Enter 发送，Shift+Enter 换行'
          }
          disabled={!currentProjectId || isStreaming}
          autoSize={{ minRows: 1, maxRows: 4 }}
          style={{
            flex: 1,
            backgroundColor: '#3c3c3c',
            border: '1px solid #3e3e3e',
            borderRadius: 8,
            color: '#cccccc',
            fontSize: 13,
            resize: 'none',
          }}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          onClick={handleSend}
          loading={isStreaming}
          disabled={!input.trim() || !currentProjectId}
          style={{ borderRadius: 8 }}
        />
      </div>
    </div>
  )
}
