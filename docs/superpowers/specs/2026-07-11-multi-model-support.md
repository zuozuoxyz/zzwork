# zzwork 多模型支持设计文档

> 扩展 AI 模块，支持用户自由配置多个大模型 provider（Anthropic / OpenAI / DeepSeek / Ollama 等），通过 base_url + api_key 即可使用

## 数据模型

### ModelConfig

```typescript
interface ModelConfig {
  id: string              // uuid
  name: string            // 显示名称，如 "Claude Sonnet" / "DeepSeek V3"
  type: 'anthropic' | 'openai_compatible'
  baseUrl: string         // API 端点
  apiKey: string          // 仅设置页可见，实际存储到 keychain
  modelId: string         // 实际模型 ID，如 "claude-sonnet-4-20250514" / "deepseek-chat"
  isDefault: boolean      // 是否为默认模型
  createdAt: string
}
```

### 存储策略

| 字段 | 存储位置 |
|------|---------|
| id, name, type, baseUrl, modelId, isDefault, createdAt | SQLite `models` 表 |
| apiKey | 系统密钥链，key = `zzwork:model:{id}` |

### SQL

```sql
CREATE TABLE models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'openai_compatible',
  base_url TEXT NOT NULL,
  model_id TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 预置模型

首次启动或 `models` 表为空时自动插入：

| name | type | base_url | model_id |
|------|------|----------|----------|
| Claude Sonnet | anthropic | https://api.anthropic.com | claude-sonnet-4-20250514 |
| GPT-4o | openai_compatible | https://api.openai.com/v1 | gpt-4o |

## Agent Service 重构

### 架构

```
agent.service.ts
  │
  ├─ buildMessages()          ← 共用：构建消息列表
  ├─ buildTools()             ← 共用：工具定义转 SDK 格式
  ├─ executeToolCalls()       ← 共用：执行工具调用
  │
  ├─ AnthropicBackend         ← 适配层
  │   ├─ sdk: @anthropic-ai/sdk
  │   ├─ system prompt → system 参数
  │   ├─ tools → anthropic tools 格式
  │   └─ response → 统一事件流
  │
  └─ OpenAICompatibleBackend  ← 适配层
      ├─ sdk: openai
      ├─ system prompt → messages[0] role:system
      ├─ tools → openai tools 格式
      └─ response → 统一事件流
```

### 统一事件流

两个后端输出完全相同的事件格式：

```
agent:start → agent:tool_call* → agent:tool_result* → agent:chunk* → agent:done
                                                                      → agent:error
```

### 后端接口

```typescript
interface AIBackend {
  chat(messages: MessageParam[], tools: Tool[], systemPrompt: string, onEvent: AgentEventCallback): Promise<string>
}
```

### 文件变化

| 文件 | 变化 |
|------|------|
| `agent.service.ts` | 重构为后端无关的循环，委托给 AIBackend |
| 新增 `src/main/services/backends/anthropic.backend.ts` | Anthropic SDK 适配器 |
| 新增 `src/main/services/backends/openai.backend.ts` | OpenAI SDK 适配器 |
| `agent-tools.ts` | 不变 |
| `prompts.ts` | 不变 |
| `agent.ipc.ts` | 参数增加 `modelId` |

### OpenAI 兼容 Backend

- 用 `openai` npm SDK（`npm install openai`）
- system prompt 作为 `messages[0]` 的 `role: 'system'`
- tools 用 `ChatCompletionTool[]` 格式
- tool_use 响应转换为统一的 tool_use block 格式
- non-streaming 调用（简化），完整响应后 emit chunk + done

## 设置 UI 改造

### SettingsModal 重写

从单一 API Key 改为模型列表管理：

- 模型列表，每项显示名称、类型标签、base_url、model_id
- ●/○ 标识默认模型，点击可切换
- 编辑按钮打开编辑弹窗，删除按钮确认后删除
- 至少保留一个模型
- 添加按钮打开添加弹窗

### 添加/编辑弹窗

- name: text input
- type: select (anthropic / openai_compatible)
- base_url: text input（如 https://api.openai.com/v1）
- api_key: password input（已保存时显示 ●●●●●●）
- model_id: text input（如 gpt-4o）

### 变化的文件

| 文件 | 变化 |
|------|------|
| `SettingsModal.tsx` | 重写 |
| `model.repo.ts` (新增) | models 表 CRUD |
| `model.ipc.ts` (新增) | model:list/create/update/delete/set-default |
| `model.api.ts` (新增) | preload API |
| `secrets.service.ts` | `getModelKey(id)` / `setModelKey(id, key)` 替换单一 getApiKey |
| `settings.ipc.ts` | 删除 has_api_key / anthropic_api_key 特殊处理 |
| `env.d.ts` | 新增 model API 类型 |

## ChatInput 模型选择器

ChatInput 顶部添加下拉：

- 显示当前选中的模型名称
- 下拉列出所有已配置模型
- ●/○ 标记默认
- 选中切换 `currentModelId`

### conversation.store 变化

- 新增 `currentModelId: string | null`
- `sendMessage` 读取 `currentModelId`，通过 `agent:run` 的 params 传递

## 删减项

- `secrets.service.ts`: 删除 `getApiKey()` / `setApiKey()` / `deleteApiKey()` 单一函数
- `settings.ipc.ts`: 删除 `has_api_key` / `anthropic_api_key` 特殊处理
- `SettingsModal.tsx`: 旧的单一 Key 输入 UI 完全替换

## IPC 通道新增

```
model:list               → list all models (不含 apiKey)
model:create {dto}       → create new model (apiKey 进 keychain)
model:update {id, dto}   → update model (含 apiKey 更新)
model:delete {id}        → delete model
model:set-default {id}   → set as default
```

## agent:run 参数变化

```typescript
interface AgentRunParams {
  projectId: string
  conversationId: string
  modelId: string           // 新增：指定使用的模型
  projectName: string
  message: string
  capability?: string
  context?: { selectedText?: string; filePath?: string }
  history?: { role: 'user' | 'assistant'; content: string }[]
}
```
