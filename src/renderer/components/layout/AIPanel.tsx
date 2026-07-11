import { useRef, useEffect } from 'react'
import { CloseOutlined, PlusOutlined, HistoryOutlined } from '@ant-design/icons'
import { Button, Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import { useUIStore } from '../../stores/ui.store'
import { useConversationStore } from '../../stores/conversation.store'
import { useProjectStore } from '../../stores/project.store'
import ChatMessage from '../ai/ChatMessage'
import ChatInput from '../ai/ChatInput'

export default function AIPanel(): JSX.Element {
  const toggleAIPanel = useUIStore((s) => s.toggleAIPanel)
  const {
    messages,
    thinkingSteps,
    isStreaming,
    streamingText,
    conversations,
    currentConvId,
    loadByProject,
    createConversation,
    setCurrentConv,
  } = useConversationStore()
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Load conversations when project changes
  useEffect(() => {
    if (currentProjectId) {
      loadByProject(currentProjectId)
    }
  }, [currentProjectId, loadByProject])

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText, thinkingSteps])

  const handleNewConversation = async () => {
    if (!currentProjectId) return
    await createConversation(currentProjectId)
  }

  const conversationMenuItems: MenuProps['items'] = conversations.map((c) => ({
    key: c.id,
    label: `${c.messages[0]?.content?.substring(0, 40) ?? '新对话'} — ${new Date(c.createdAt).toLocaleDateString('zh-CN')}`,
    onClick: () => setCurrentConv(c.id),
  }))

  return (
    <>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 12px',
        borderBottom: '1px solid #3e3e3e',
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: '#999',
        }}>
          🤖 AI 助手
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined />}
            onClick={handleNewConversation}
            disabled={!currentProjectId}
            style={{ color: '#999' }}
          />
          <Dropdown menu={{ items: conversationMenuItems }} trigger={['click']} disabled={conversations.length === 0}>
            <Button
              type="text"
              size="small"
              icon={<HistoryOutlined />}
              style={{ color: '#999' }}
            />
          </Dropdown>
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined />}
            onClick={toggleAIPanel}
            style={{ color: '#999' }}
          />
        </div>
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '12px',
      }}>
        {messages.length === 0 && !isStreaming ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: '#555',
            textAlign: 'center',
          }}>
            <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.3 }}>🤖</div>
            <div style={{ fontSize: 13, marginBottom: 4 }}>
              {currentProjectId ? '开始对话' : '请先选择一个项目'}
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.6 }}>
              支持 /analyze /report /decompose 等快捷指令<br />
              选中编辑器文本后发送可引用上下文
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <ChatMessage
                key={i}
                message={msg}
                thinkingSteps={
                  i === messages.length - 1 && msg.role === 'assistant' && msg.toolCalls
                    ? msg.toolCalls.map((tc) => ({
                        tool: tc.tool,
                        input: tc.input,
                        status: 'done' as const,
                        result: tc.result,
                      }))
                    : undefined
                }
              />
            ))}

            {/* Streaming message */}
            {isStreaming && (
              <ChatMessage
                message={{
                  role: 'assistant',
                  content: '',
                  timestamp: new Date().toISOString(),
                }}
                thinkingSteps={thinkingSteps}
                isStreaming={true}
                streamingText={streamingText}
              />
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input */}
      <ChatInput />
    </>
  )
}
