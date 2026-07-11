import { Card, Dropdown, Tag } from 'antd'
import { MoreOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import type { MenuProps } from 'antd'
import type { ProgressItem, ProgressStatus, UpdateProgressDTO } from '../../types/progress'

const COLUMNS: { status: ProgressStatus; title: string; color: string }[] = [
  { status: 'todo',     title: '待开始', color: '#6a6a6a' },
  { status: 'doing',    title: '进行中', color: '#007acc' },
  { status: 'done',     title: '已完成', color: '#4d9e4d' },
  { status: 'blocked',  title: '已阻塞', color: '#d16969' },
]

const PRIORITY_COLORS: Record<string, string> = {
  high: '#d16969',
  medium: '#d7ba7d',
  low: '#6a6a6a',
}

interface Props {
  items: ProgressItem[]
  onEdit: (item: ProgressItem) => void
  onDelete: (id: string) => void
  onStatusChange: (id: string, status: ProgressStatus) => void
}

export default function ProgressKanban({ items, onEdit, onDelete, onStatusChange }: Props): JSX.Element {
  return (
    <div style={{
      display: 'flex',
      gap: 8,
      padding: '0 8px 8px',
      overflow: 'auto',
    }}>
      {COLUMNS.map((col) => {
        const columnItems = items.filter((i) => i.status === col.status)
        return (
          <div
            key={col.status}
            style={{
              flex: '1 1 0',
              minWidth: 160,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              color: col.color,
              padding: '4px 8px',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}>
              {col.title}
              <span style={{ color: '#666', fontWeight: 400 }}>
                {columnItems.length}
              </span>
            </div>

            {columnItems.length === 0 ? (
              <div style={{
                padding: 12,
                color: '#555',
                fontSize: 11,
                textAlign: 'center',
                border: '1px dashed #3e3e3e',
                borderRadius: 4,
              }}>
                拖拽或添加
              </div>
            ) : (
              columnItems.map((item) => {
                const menuItems: MenuProps['items'] = [
                  ...COLUMNS.filter((c) => c.status !== item.status).map((c) => ({
                    key: `move-${c.status}`,
                    label: `移动到 ${c.title}`,
                    onClick: () => onStatusChange(item.id, c.status),
                  })),
                  { type: 'divider' as const },
                  {
                    key: 'edit',
                    label: '编辑',
                    icon: <EditOutlined />,
                    onClick: () => onEdit(item),
                  },
                  {
                    key: 'delete',
                    label: '删除',
                    icon: <DeleteOutlined />,
                    danger: true,
                    onClick: () => onDelete(item.id),
                  },
                ]

                return (
                  <Card
                    key={item.id}
                    size="small"
                    styles={{ body: { padding: '8px 12px' } }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 13,
                          color: '#cccccc',
                          wordBreak: 'break-word',
                          marginBottom: 6,
                        }}>
                          {item.title}
                        </div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {item.priority && (
                            <Tag
                              color={PRIORITY_COLORS[item.priority]}
                              style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}
                            >
                              {item.priority === 'high' ? '高' : item.priority === 'medium' ? '中' : '低'}
                            </Tag>
                          )}
                          {item.estimatedHours != null && (
                            <Tag style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}>
                              {item.estimatedHours}h
                            </Tag>
                          )}
                        </div>
                      </div>
                      <Dropdown menu={{ items: menuItems }} trigger={['click']}>
                        <MoreOutlined style={{
                          color: '#666',
                          cursor: 'pointer',
                          padding: '2px 4px',
                          fontSize: 12,
                        }} />
                      </Dropdown>
                    </div>
                  </Card>
                )
              })
            )}
          </div>
        )
      })}
    </div>
  )
}
