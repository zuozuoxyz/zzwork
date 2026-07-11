# WorkTracker 设计文档

> VS Code 风格的桌面工作管理工具：项目管理 + 文件编辑 + AI 助手 + 进度追踪

## 技术栈

| 层面 | 选型 | 理由 |
|------|------|------|
| 桌面框架 | Electron | VS Code 验证过的方案，生态成熟 |
| 构建工具 | electron-vite | 开箱支持 main/preload/renderer 三入口 HMR |
| 前端 UI | React 18 + TypeScript | 组件化，Monaco Editor 原生支持 |
| UI 组件库 | Ant Design 5 | 组件全（Tree/Table/Modal），暗色主题+紧凑模式 |
| 状态管理 | Zustand | 轻量、TS 友好、适合单窗口应用 |
| 代码编辑器 | Monaco Editor | VS Code 同款编辑器 |
| 本地存储 | SQLite (better-sqlite3) | 轻量，存项目/进度/会话 |
| AI 引擎 | Claude Agent SDK (Anthropic) | Agent 模式：自主读文件、查数据、多步推理 |
| 密钥存储 | keytar | macOS Keychain / Windows Credential Manager / Linux libsecret |
| 打包 | electron-builder | .exe / .dmg / .AppImage |

## UI 布局

```
┌─────────────────────────────────────────────────────────┐
│  🔧 顶部菜单栏  │  文件  编辑  视图  帮助            │
├────────┬──────────────────────────┬─────────────────────┤
│        │                          │                     │
│  📁    │    📝 编辑器区域          │  🤖 AI 助手        │
│ 项目   │                          │                     │
│ 树     │   Monaco Editor          │  ChatMessage        │
│        │   - 多标签页              │  - 思考步骤展示     │
│ ────── │   - 语法高亮              │  - 工具调用展示     │
│ 📋    │   - 搜索替换              │  - 流式文本         │
│ 进度   │                          │  ChatInput          │
│ 面板   │                          │  - /快捷指令        │
│        │                          │  - 上下文注入        │
├────────┴──────────────────────────┴─────────────────────┤
│  📊 底部状态栏：当前项目 | 进度 % | AI 模型 | 时间      │
└─────────────────────────────────────────────────────────┘
```

## 项目目录结构

```
worktracker/
├── electron.vite.config.ts
├── electron-builder.yml
├── package.json
├── tsconfig.json
├── resources/                       # 图标等静态资源
│
├── src/
│   ├── main/                        # ===== 主进程 =====
│   │   ├── index.ts                 # 入口：创建窗口、注册 IPC handler
│   │   ├── ipc/
│   │   │   ├── index.ts             # 聚合 + wrapHandler 装饰器
│   │   │   ├── project.ipc.ts
│   │   │   ├── progress.ipc.ts
│   │   │   ├── file.ipc.ts
│   │   │   ├── conversation.ipc.ts
│   │   │   ├── agent.ipc.ts
│   │   │   └── settings.ipc.ts
│   │   ├── db/
│   │   │   ├── connection.ts        # better-sqlite3 连接
│   │   │   ├── migrations/
│   │   │   └── repositories/
│   │   │       ├── project.repo.ts
│   │   │       ├── progress.repo.ts
│   │   │       ├── conversation.repo.ts
│   │   │       └── settings.repo.ts
│   │   ├── services/
│   │   │   ├── project.service.ts
│   │   │   ├── progress.service.ts
│   │   │   ├── agent.service.ts     # Claude Agent SDK 调用
│   │   │   ├── agent-tools.ts       # Agent 可用工具定义
│   │   │   ├── prompts.ts           # System prompt 模板
│   │   │   └── secrets.service.ts   # keytar 密钥管理
│   │   └── utils/
│   │       └── paths.ts
│   │
│   ├── preload/                     # ===== 预加载脚本 =====
│   │   ├── index.ts                 # contextBridge.exposeInMainWorld
│   │   └── api/
│   │       ├── project.api.ts
│   │       ├── progress.api.ts
│   │       ├── file.api.ts
│   │       ├── conversation.api.ts
│   │       ├── agent.api.ts
│   │       └── settings.api.ts
│   │
│   └── renderer/                    # ===== 渲染进程 =====
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── stores/                  # Zustand stores
│       │   ├── project.store.ts
│       │   ├── progress.store.ts
│       │   ├── editor.store.ts
│       │   ├── conversation.store.ts
│       │   ├── ui.store.ts
│       │   └── settings.store.ts
│       ├── components/
│       │   ├── layout/              # AppShell, Sidebar, StatusBar
│       │   ├── project/             # ProjectTree, ProjectCreateModal
│       │   ├── progress/            # ProgressPanel, ProgressKanban, ProgressForm
│       │   ├── editor/              # EditorTabs, MonacoEditor, FileExplorer
│       │   ├── ai/                  # ChatPanel, ChatMessage, ChatInput, ContextSelector
│       │   ├── settings/            # SettingsModal
│       │   └── shared/              # IconButton, ConfirmDialog
│       ├── hooks/
│       │   ├── useIpc.ts            # 封装 IPC 调用 + 统一错误处理
│       │   └── useAutoSave.ts
│       ├── styles/
│       │   ├── theme.ts             # Ant Design theme token (VS Code 风格)
│       │   ├── global.css
│       │   └── vscode-vars.css
│       └── types/
│           ├── project.ts
│           ├── progress.ts
│           ├── conversation.ts
│           ├── ipc.ts               # IPC 通道常量和参数类型
│           └── errors.ts            # AppError 和 ErrorCode
```

## IPC 通信设计

### 通道命名规范

采用 `domain:action` 格式：

```
project:list | get | create | update | delete | archive
progress:list | create | update | delete | reorder
file:read | write | list | delete | create
conversation:list | get | create | append | delete
agent:run                              ← Agent 执行（主通道）
  + event: agent:start | chunk | tool_call | tool_result | done | error
settings:get | set | get-all
```

### 数据流（Agent 调用为例）

```
渲染进程                         Preload                     主进程
────────                        ────────                    ──────
ChatInput
  └─ store.sendMessage()
       └─ window.api.agent.run(params)
            └─ ipcRenderer.invoke('agent:run', params)
                  │
                  │           contextBridge             ipcMain.handle('agent:run', ...)
                  │           (纯透传)                     │
                  │                                        ├─ agent.service.run()
                  │                                        │    ├─ 读 API Key (keytar)
                  │                                        │    ├─ 构建 system prompt + tools
                  │                                        │    ├─ Anthropic messages.create()
                  │                                        │    ├─ tool_use 循环:
                  │                                        │    │    ├─ query_progress()
                  │                                        │    │    ├─ list_files()
                  │                                        │    │    ├─ read_file()
                  │                                        │    │    └─ ...
                  │                                        │    ├─ 逐事件 → event.sender.send()
                  │                                        │    └─ 保存对话到 SQLite
                  │                                        │
                  │  ◄── agent:start                       │
                  │  ◄── agent:tool_call (每个工具调用)     │
                  │  ◄── agent:tool_result                 │
                  │  ◄── agent:chunk (最终文本流)           │
                  │  ◄── agent:done                        │
                  │
  ◄── store 逐事件更新 UI
```

### Preload API 形态

```typescript
contextBridge.exposeInMainWorld('api', {
  project:      { list, get, create, update, delete, archive },
  progress:     { list, create, update, delete, reorder },
  file:         { read, write, list, delete, create },
  conversation: { list, get, create, append, delete },
  settings:     { get, set, getAll, setApiKey },
  agent: {
    run: (params) => ipcRenderer.invoke('agent:run', params),
    onStart:     (cb) => ipcRenderer.on('agent:start', cb),
    onChunk:     (cb) => ipcRenderer.on('agent:chunk', cb),
    onToolCall:  (cb) => ipcRenderer.on('agent:tool_call', cb),
    onToolResult:(cb) => ipcRenderer.on('agent:tool_result', cb),
    onDone:      (cb) => ipcRenderer.on('agent:done', cb),
    onError:     (cb) => ipcRenderer.on('agent:error', cb),
    removeAll:   () => { /* removeAllListeners for agent events */ },
  },
});
```

### IPC 响应格式

所有 handler 通过 `wrapHandler` 装饰器统一返回：

```typescript
// 成功
{ ok: true, data: T }

// 失败
{ ok: false, error: { code: ErrorCode, message: string, detail?: string } }
```

## 状态管理

### Zustand Store 拆分

| Store | 职责 | 关键数据 |
|-------|------|---------|
| `project.store` | 项目 CRUD、当前项目 | projects[], currentProjectId |
| `progress.store` | 进度条目、筛选 | items[], filter{} |
| `editor.store` | 标签页、当前文件、脏状态 | openTabs[], activeTabId |
| `conversation.store` | AI 对话、消息、流式状态 | conversations[], messages{}, isStreaming |
| `ui.store` | 侧栏宽度、面板显隐、主题 | sidebarWidth, aiPanelVisible |
| `settings.store` | API Key 存在状态、偏好缓存 | hasApiKey, preferences{} |

### 数据流规则

1. Store → IPC(preload) → 主进程 → SQLite/API，单向
2. Store 间通过 `useOtherStore.getState()` 读取，避免循环依赖
3. 项目切换时通过组件层 `useEffect` 监听 `currentProjectId` 变化触发联动加载
4. Agent 事件通过 `window.api.agent.onXxx(callback)` 推送到 store

## Agent 工具集

| 工具 | 功能 | 关键参数 |
|------|------|---------|
| `read_file` | 读取项目文件内容 | project_id, file_path |
| `list_files` | 列出项目目录 | project_id, pattern? |
| `query_progress` | 查询进度数据 | project_id, status?, days_stale? |
| `search_code` | 搜索文件关键词 | project_id, query, file_pattern? |
| `read_conversation` | 读取历史对话 | conversation_id, limit? |
| `save_note` | 创建笔记/报告文件 | project_id, filename, content |
| `update_progress` | 更新进度条目 | progress_id, status?, notes? |

## Agent System Prompts

| 能力 | 触发 | 描述 |
|------|------|------|
| default | 普通对话 | 工作管理助手，简洁专业 |
| analyzeProgress | `/analyze` | 找出阻滞任务、异常模块、下一步建议 |
| generateReport | `/report` | 生成本周总结（完成/进行中/计划/风险） |
| reviewRequirement | 选中文本 + "/review" | 技术可行性、风险、边界情况、改进建议 |
| decomposeTask | `/decompose` | 拆解为子任务（标题/工时/优先级/依赖） |

## 数据库设计

```sql
-- 项目表
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT,
  status TEXT DEFAULT 'active',  -- active/archived
  created_at DATETIME,
  updated_at DATETIME
);

-- 进度表
CREATE TABLE progress (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT DEFAULT 'todo',    -- todo/doing/done/blocked
  priority TEXT DEFAULT 'medium',-- low/medium/high
  notes TEXT,
  tags TEXT,                     -- JSON array
  estimated_hours REAL,
  actual_hours REAL,
  created_at DATETIME,
  updated_at DATETIME
);

-- AI 对话记录
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  messages TEXT,                 -- JSON: [{role, content, tool_calls?, timestamp}]
  summary TEXT,
  created_at DATETIME
);

-- 设置表
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

## 设置管理

### 存储策略

| 数据类型 | 位置 | 方式 |
|---------|------|------|
| 通用设置 | SQLite settings 表 | 主进程读写，IPC 暴露 |
| API Key | 系统密钥链 (keytar) | macOS Keychain / Windows Credential Manager / Linux libsecret |
| UI 偏好 | localStorage | 渲染进程直接读写 |

### 首次启动

```
应用启动 → 检查 SQLite + 密钥链
  ├─ 无 API Key → UI 显示引导/设置提示
  ├─ 有 API Key → 加载设置，正常进入
  └─ 数据目录不存在 → 自动创建
```

## 错误处理

### 三层策略

| 层 | 职责 |
|----|------|
| 主进程 IPC Handler | wrapHandler 装饰器统一 catch → `{ ok: false, error }` |
| 渲染进程 useIpc | 解析 error code → Toast 通知 + 引导动作 |
| 全局兜底 | main: `uncaughtException` → dialog; renderer: ErrorBoundary |

### 错误码

```
DB_CONNECTION_FAILED | DB_MIGRATION_FAILED | DB_QUERY_FAILED
FILE_NOT_FOUND | FILE_READ_FAILED | FILE_WRITE_FAILED | FILE_ALREADY_EXISTS
AI_API_KEY_MISSING | AI_API_ERROR | AI_TIMEOUT | AI_RATE_LIMITED | AI_INVALID_RESPONSE
PROJECT_NOT_FOUND | PROJECT_NAME_DUPLICATE
IPC_TIMEOUT | IPC_UNKNOWN_CHANNEL
```

### 超时

- Agent 调用：30 秒无新事件 → `agent:error`
- 其他 IPC：10 秒默认超时

## 组件树

```
<App>
  <ConfigProvider theme={antdTheme}>
    <AppShell>                          ← CSS Grid 三栏
      <Sidebar>                         ← 左栏
        <ProjectTree />
        <ProgressPanel>
          <ProgressKanban />
          <ProgressStats />             ← Phase 3
        </ProgressPanel>
      </Sidebar>
      <EditorArea>                      ← 中栏
        <EditorTabs />
        <MonacoEditor />
      </EditorArea>
      <AIPanel>                         ← 右栏（可折叠）
        <ChatMessage />                 ← 含思考步骤 + 工具调用展示
        <ChatInput />                   ← 支持 /快捷指令
      </AIPanel>
      <StatusBar />                     ← 底部
    </AppShell>
    <SettingsModal />
    <ProjectCreateModal />
  </ConfigProvider>
</App>
```

## 项目存储模型

混合模式：
- 默认：应用数据目录下自管理 `projects/`，每个项目一个文件夹
- 增强：支持"打开外部文件夹"作为项目

## 开发路线图

### Phase 1：MVP
- 基础 UI 框架（三栏布局）
- 项目创建/列表
- Monaco Editor 集成
- 简单进度记录（增删改查）
- 本地 SQLite 存储

### Phase 2：AI 集成
- Agent 工具集实现（7 个工具）
- Claude Agent SDK 对接
- 流式 + tool_use 事件循环
- UI 思考步骤展示
- 选中文本提问

### Phase 3：增强功能
- 进度统计图表
- 周报自动生成
- 快捷键支持
- 设置页面
- 外部文件夹项目

### Phase 4：打磨
- 插件系统
- 更多 AI 模型支持
- 自定义主题
