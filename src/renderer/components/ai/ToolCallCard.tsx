import { Card, Tag, Typography } from 'antd'
import { ToolOutlined, CheckCircleOutlined, LoadingOutlined } from '@ant-design/icons'
import type { ThinkingStep } from '../../stores/conversation.store'

const { Text, Paragraph } = Typography

const TOOL_LABELS: Record<string, string> = {
  read_file: '读取文件',
  list_files: '列出文件',
  query_progress: '查询进度',
  search_code: '搜索代码',
  read_conversation: '读取对话',
  save_note: '保存笔记',
  update_progress: '更新进度',
}

interface Props {
  step: ThinkingStep
}

export default function ToolCallCard({ step }: Props): JSX.Element {
  const isRunning = step.status === 'running'
  const label = TOOL_LABELS[step.tool] ?? step.tool

  return (
    <Card
      size="small"
      styles={{ body: { padding: '8px 12px' } }}
      style={{ marginBottom: 4, backgroundColor: isRunning ? '#2a2d2e' : '#252526' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {isRunning
          ? <LoadingOutlined style={{ color: '#007acc' }} />
          : <CheckCircleOutlined style={{ color: '#4d9e4d' }} />
        }
        <Tag color="blue" style={{ margin: 0, fontSize: 11 }}>{label}</Tag>
        <Text style={{ fontSize: 12, color: '#999' }}>
          {Object.entries(step.input).slice(0, 2).map(([k, v]) =>
            `${k}: ${String(v).substring(0, 40)}`
          ).join(', ')}
        </Text>
      </div>
      {step.result && !isRunning && (
        <Paragraph
          style={{ margin: '4px 0 0 24px', fontSize: 11, color: '#777' }}
          ellipsis={{ rows: 2 }}
        >
          {step.result}
        </Paragraph>
      )}
    </Card>
  )
}
