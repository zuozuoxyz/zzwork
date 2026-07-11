import { useUIStore } from '../../stores/ui.store'
import { CloseOutlined, RobotOutlined } from '@ant-design/icons'
import { Button } from 'antd'

export default function AIPanel(): JSX.Element {
  const toggleAIPanel = useUIStore((s) => s.toggleAIPanel)

  return (
    <>
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
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined />}
          onClick={toggleAIPanel}
          style={{ color: '#999' }}
        />
      </div>

      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#555',
        padding: 24,
        textAlign: 'center',
      }}>
        <RobotOutlined style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }} />
        <div style={{ fontSize: 14, marginBottom: 8 }}>AI 助手</div>
        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
          Phase 2 将集成 Claude Agent<br />
          支持进度分析、周报生成、需求评审
        </div>
      </div>
    </>
  )
}
