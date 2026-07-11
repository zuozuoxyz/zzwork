import { Typography } from 'antd'
import { UserOutlined, RobotOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import type { ConversationMessage } from '../../types/conversation'
import type { ThinkingStep } from '../../stores/conversation.store'
import ToolCallCard from './ToolCallCard'

const { Text } = Typography

interface Props {
  message: ConversationMessage
  thinkingSteps?: ThinkingStep[]
  isStreaming?: boolean
  streamingText?: string
}

export default function ChatMessage({ message, thinkingSteps, isStreaming, streamingText }: Props): JSX.Element {
  const isUser = message.role === 'user'
  const isEmpty = !message.content && (!thinkingSteps || thinkingSteps.length === 0)

  if (isEmpty) return <></>

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 12,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginBottom: 4,
      }}>
        {isUser
          ? <UserOutlined style={{ fontSize: 12, color: '#569cd6' }} />
          : <RobotOutlined style={{ fontSize: 12, color: '#4ec9b0' }} />
        }
        <Text style={{ fontSize: 11, color: '#666' }}>
          {isUser ? '你' : 'AI 助手'}
        </Text>
        <Text style={{ fontSize: 10, color: '#555' }}>
          {new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </div>

      {/* Tool calls (shown before AI response) */}
      {!isUser && thinkingSteps && thinkingSteps.length > 0 && (
        <div style={{ width: '100%', marginBottom: 8 }}>
          {thinkingSteps.map((step, i) => (
            <ToolCallCard key={`${step.tool}-${i}`} step={step} />
          ))}
        </div>
      )}

      {/* Message content */}
      {(message.content || (isStreaming && streamingText)) && (
        <div style={{
          maxWidth: '85%',
          padding: '8px 12px',
          borderRadius: 8,
          backgroundColor: isUser ? '#094771' : '#2d2d2d',
          border: isUser ? '1px solid #007acc' : '1px solid #3e3e3e',
        }}>
          {isUser ? (
            <Text style={{ color: '#cccccc', fontSize: 13, whiteSpace: 'pre-wrap' }}>
              {message.content}
            </Text>
          ) : (
            <div style={{ color: '#cccccc', fontSize: 13, lineHeight: 1.6 }} className="ai-message-content">
              <ReactMarkdown>
                {isStreaming ? (streamingText || '') : message.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
