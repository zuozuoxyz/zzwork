# zzwork Phase 2 AI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Claude Agent SDK into the AI panel with tool-use loop, streaming responses, thinking-step visualization, and selected-text context injection.

**Architecture:** Main process hosts the Anthropic SDK, API key in system keychain, 7 agent tools for file/progress/DB access. IPC uses `agent:run` invoke + `agent:chunk`/`agent:tool_call`/`agent:done` events for streaming. Renderer conversation store manages messages and streaming state. AIPanel renders ChatMessage (with tool-call cards) + ChatInput (with /commands).

**Tech Stack:** @anthropic-ai/sdk, keytar, existing Zustand stores (project, progress, editor, ui)

## Global Constraints

- No tests (deferred per design decision)
- API Key stored in system keychain via keytar — never exposed to renderer
- Agent IPC: `agent:run` invoke (request) + events: `agent:start`, `agent:chunk`, `agent:tool_call`, `agent:tool_result`, `agent:done`, `agent:error`
- 7 agent tools: read_file, list_files, query_progress, search_code, read_conversation, save_note, update_progress
- System prompts for 4 capabilities: default, analyzeProgress (/analyze), generateReport (/report), reviewRequirement (selected text + /review), decomposeTask (/decompose)
- Streaming: text chunks delivered via IPC events; final text saved to SQLite conversations table
- UI shows thinking steps: tool calls displayed as collapsible cards between user message and AI response

---

## File Map

```
src/
├── main/
│   ├── index.ts                          [Task 2 - modify: init keytar + register agent IPC]
│   ├── ipc/
│   │   ├── agent.ipc.ts                  [Task 5 - create]
│   │   └── conversation.ipc.ts           [Task 6 - create]
│   ├── services/
│   │   ├── secrets.service.ts            [Task 2 - create]
│   │   ├── agent.service.ts              [Task 4 - create]
│   │   ├── agent-tools.ts                [Task 3 - create]
│   │   └── prompts.ts                    [Task 3 - create]
│   └── db/
│       └── repositories/
│           └── conversation.repo.ts      [Task 6 - create]
│
├── preload/
│   ├── index.ts                          [Task 8 - modify: add agent + conversation APIs]
│   └── api/
│       ├── agent.api.ts                  [Task 7 - create]
│       └── conversation.api.ts           [Task 7 - create]
│
└── renderer/
    ├── env.d.ts                           [Task 8 - modify: add agent + conversation types]
    ├── stores/
    │   └── conversation.store.ts          [Task 9 - create]
    ├── components/
    │   ├── layout/
    │   │   └── AIPanel.tsx               [Task 13 - modify: replace placeholder]
    │   ├── ai/
    │   │   ├── ChatMessage.tsx            [Task 11 - create]
    │   │   ├── ChatInput.tsx              [Task 12 - create]
    │   │   └── ToolCallCard.tsx           [Task 11 - create]
    │   └── settings/
    │       └── SettingsModal.tsx          [Task 14 - create]
    └── types/
        └── conversation.ts               [Task 1 - create]
```

---

### Task 1: Conversation Types + Dependencies

**Files:**
- Create: `src/renderer/types/conversation.ts`
- Modify: `package.json` (add @anthropic-ai/sdk, keytar)

**Produces:** Conversation type definitions, npm dependencies installed

- [ ] **Step 1: Create src/renderer/types/conversation.ts**

```typescript
export interface Conversation {
  id: string
  projectId: string
  messages: ConversationMessage[]
  summary: string | null
  createdAt: string
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCalls?: ToolCallRecord[]
  timestamp: string
}

export interface ToolCallRecord {
  tool: string
  input: Record<string, unknown>
  result: string
}

export interface ChatContext {
  selectedText?: string
  filePath?: string
}

export interface AgentEvent {
  type: 'start' | 'chunk' | 'tool_call' | 'tool_result' | 'done' | 'error'
  data: AgentStartData | AgentChunkData | AgentToolCallData | AgentToolResultData | AgentDoneData | AgentErrorData
}

export interface AgentStartData { conversationId: string }
export interface AgentChunkData { conversationId: string; content: string }
export interface AgentToolCallData { conversationId: string; tool: string; input: Record<string, unknown> }
export interface AgentToolResultData { conversationId: string; tool: string; summary: string }
export interface AgentDoneData { conversationId: string; content: string }
export interface AgentErrorData { conversationId: string; code: string; message: string }

export interface AgentRunParams {
  projectId: string
  conversationId: string
  message: string
  capability?: 'default' | 'analyze' | 'report' | 'review' | 'decompose'
  context?: ChatContext
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd /home/zuozuo/sf/zzwork && npm install @anthropic-ai/sdk keytar && npm install -D @types/keytar
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add conversation types and AI dependencies"
```

---

### Task 2: Secrets Service

**Files:**
- Create: `src/main/services/secrets.service.ts`

**Produces:** `getApiKey()` / `setApiKey()` backed by system keychain

- [ ] **Step 1: Create src/main/services/secrets.service.ts**

```typescript
import keytar from 'keytar'

const SERVICE_NAME = 'zzwork'
const ACCOUNT_NAME = 'anthropic-api-key'

export async function getApiKey(): Promise<string | null> {
  try {
    return await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME)
  } catch {
    // keytar may not be available on all Linux configs
    return null
  }
}

export async function setApiKey(key: string): Promise<void> {
  try {
    await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, key)
  } catch {
    throw new Error('无法存储 API Key，请检查系统密钥链是否可用')
  }
}

export async function deleteApiKey(): Promise<void> {
  try {
    await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME)
  } catch {
    // ignore
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: add secrets service backed by system keychain"
```

---

### Task 3: Agent Tools + System Prompts

**Files:**
- Create: `src/main/services/agent-tools.ts`, `src/main/services/prompts.ts`

**Produces:** 7 tool definitions with execute functions, 5 system prompt templates

- [ ] **Step 1: Create src/main/services/prompts.ts**

```typescript
export const SYSTEM_PROMPTS = {
  default: `你是 zzwork 的工作管理助手，能帮助用户跟踪项目进度、分析需求、生成报告。

你的能力：
- 查询项目进度数据（自动调用 query_progress 工具）
- 读取项目文件内容（自动调用 read_file 工具）
- 搜索项目中的代码/文档（自动调用 search_code 工具）
- 生成和保存笔记/报告（自动调用 save_note 工具）
- 更新进度状态（自动调用 update_progress 工具）

当前项目名称: {projectName}
请用简洁专业的中文回答。回答时使用 Markdown 格式。`,

  analyzeProgress: `分析以下项目进度数据，找出:
1. 阻滞的任务（超过3天未更新或状态为 blocked）
2. 进度异常的模块（迟迟未推进的）
3. 下一步应该优先做什么

先调用 query_progress 获取数据，分析后给出具体建议。
如果需要，可以读取项目文件了解更多上下文。`,

  generateReport: `根据项目进度数据和文件内容，生成一份本周工作总结报告：
- 本周完成的工作（status=done 且最近更新的条目）
- 进行中的工作及进度百分比
- 下周计划
- 风险和阻塞

先调用 query_progress 获取数据，然后用 save_note 将报告保存为 report-YYYY-MM-DD.md。
格式使用专业的 Markdown。`,

  reviewRequirement: `你是一个技术评审专家。分析用户选中的需求文本，从以下维度评审：
1. 技术可行性 - 是否合理可实现？
2. 潜在风险 - 有什么技术或进度风险？
3. 是否有遗漏的边界情况？
4. 改进建议 - 具体的优化方向

如果需求涉及项目现有文件，可以调用 read_file 了解更多上下文。`,

  decomposeTask: `将以下需求拆解为可执行的子任务。每个子任务包含：
- 标题
- 预估工时（小时）
- 优先级（high/medium/low）
- 前置依赖（如果有）

先调用 query_progress 了解现有进度，避免重复。
输出格式: Markdown 表格。`,
}

export function buildSystemPrompt(
  capability: string | undefined,
  projectName: string
): string {
  const template = SYSTEM_PROMPTS[capability as keyof typeof SYSTEM_PROMPTS] ?? SYSTEM_PROMPTS.default
  return template.replace('{projectName}', projectName)
}
```

- [ ] **Step 2: Create src/main/services/agent-tools.ts**

```typescript
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { getProjectsDir } from '../utils/paths'
import { progressRepo } from '../db/repositories/progress.repo'
import { getConnection } from '../db/connection'
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages'

export interface ToolDefinition {
  definition: Tool
  execute: (input: Record<string, unknown>, projectId: string) => Promise<string> | string
}

function resolvePath(projectId: string, filePath: string): string {
  const baseDir = join(getProjectsDir(), projectId)
  const fullPath = join(baseDir, filePath)
  if (!fullPath.startsWith(baseDir)) {
    throw new Error('无效的文件路径')
  }
  return fullPath
}

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    definition: {
      name: 'read_file',
      description: '读取项目中的文件内容（Markdown、代码、文档等）',
      input_schema: {
        type: 'object' as const,
        properties: {
          project_id: { type: 'string', description: '项目 ID' },
          file_path: { type: 'string', description: '相对于项目根目录的文件路径' },
        },
        required: ['project_id', 'file_path'],
      },
    },
    execute: (input) => {
      const fullPath = resolvePath(input.project_id as string, input.file_path as string)
      if (!existsSync(fullPath)) return `文件不存在: ${input.file_path}`
      return readFileSync(fullPath, 'utf-8')
    },
  },
  {
    definition: {
      name: 'list_files',
      description: '列出项目目录下的所有文件',
      input_schema: {
        type: 'object' as const,
        properties: {
          project_id: { type: 'string', description: '项目 ID' },
          pattern: { type: 'string', description: '可选的文件名过滤，如 *.md' },
        },
        required: ['project_id'],
      },
    },
    execute: (input) => {
      const projectDir = join(getProjectsDir(), input.project_id as string)
      if (!existsSync(projectDir)) return '项目目录不存在'
      const files = readdirSync(projectDir, { recursive: true, encoding: 'utf-8' })
      const pattern = input.pattern as string | undefined
      if (pattern) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'))
        return files.filter((f) => regex.test(f)).join('\n') || '无匹配文件'
      }
      return files.join('\n') || '目录为空'
    },
  },
  {
    definition: {
      name: 'query_progress',
      description: '查询项目的进度数据，支持按状态筛选，支持查找 N 天未更新的停滞条目',
      input_schema: {
        type: 'object' as const,
        properties: {
          project_id: { type: 'string', description: '项目 ID' },
          status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'], description: '按状态筛选' },
          days_stale: { type: 'number', description: '筛选超过 N 天未更新的条目' },
        },
        required: ['project_id'],
      },
    },
    execute: (input) => {
      const items = progressRepo.listByProject(input.project_id as string)
      let filtered = items

      if (input.status) {
        filtered = filtered.filter((i) => i.status === input.status)
      }
      if (input.days_stale) {
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - (input.days_stale as number))
        filtered = filtered.filter((i) => new Date(i.updatedAt) < cutoff)
      }

      if (filtered.length === 0) return '暂无匹配的进度条目'

      return filtered.map((i) =>
        `[${i.status}] ${i.title} | 优先级: ${i.priority} | 更新: ${i.updatedAt}${i.estimatedHours ? ` | 预估: ${i.estimatedHours}h` : ''}`
      ).join('\n')
    },
  },
  {
    definition: {
      name: 'search_code',
      description: '在项目文件中搜索特定关键词或正则表达式',
      input_schema: {
        type: 'object' as const,
        properties: {
          project_id: { type: 'string', description: '项目 ID' },
          query: { type: 'string', description: '搜索关键词或正则' },
          file_pattern: { type: 'string', description: '文件过滤，如 *.ts' },
        },
        required: ['project_id', 'query'],
      },
    },
    execute: (input) => {
      const projectDir = join(getProjectsDir(), input.project_id as string)
      if (!existsSync(projectDir)) return '项目目录不存在'

      const files = readdirSync(projectDir, { recursive: true, encoding: 'utf-8' })
      const pattern = input.file_pattern as string | undefined
      const targetFiles = pattern
        ? files.filter((f) => new RegExp(pattern.replace(/\*/g, '.*')).test(f))
        : files

      const results: string[] = []
      const query = input.query as string
      for (const file of targetFiles) {
        try {
          const content = readFileSync(join(projectDir, file), 'utf-8')
          const lines = content.split('\n')
          lines.forEach((line, idx) => {
            if (line.includes(query)) {
              results.push(`${file}:${idx + 1}: ${line.trim().substring(0, 120)}`)
            }
          })
        } catch { /* skip binary/unreadable files */ }
      }

      return results.length > 0
        ? results.slice(0, 30).join('\n')
        : `未找到包含 "${query}" 的文件`
    },
  },
  {
    definition: {
      name: 'read_conversation',
      description: '读取最近的对话记录，用于回顾之前的讨论上下文',
      input_schema: {
        type: 'object' as const,
        properties: {
          conversation_id: { type: 'string', description: '对话 ID' },
          limit: { type: 'number', description: '读取最近 N 条消息，默认 20', default: 20 },
        },
        required: ['conversation_id'],
      },
    },
    execute: (input) => {
      const db = getConnection()
      const row = db.prepare('SELECT messages FROM conversations WHERE id = ?').get(input.conversation_id as string) as { messages: string } | undefined
      if (!row) return '对话不存在'

      const messages = JSON.parse(row.messages)
      const limit = (input.limit as number) || 20
      const recent = messages.slice(-limit)
      return JSON.stringify(recent, null, 2)
    },
  },
  {
    definition: {
      name: 'save_note',
      description: '在项目中创建一个笔记或报告文件',
      input_schema: {
        type: 'object' as const,
        properties: {
          project_id: { type: 'string', description: '项目 ID' },
          filename: { type: 'string', description: '文件名，如 report-2026-07-11.md' },
          content: { type: 'string', description: '文件内容（Markdown 格式）' },
        },
        required: ['project_id', 'filename', 'content'],
      },
    },
    execute: (input) => {
      const fullPath = resolvePath(input.project_id as string, input.filename as string)
      const dir = dirname(fullPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(fullPath, input.content as string, 'utf-8')
      return `文件已保存: ${input.filename}`
    },
  },
  {
    definition: {
      name: 'update_progress',
      description: '更新进度条目的状态、备注等信息',
      input_schema: {
        type: 'object' as const,
        properties: {
          progress_id: { type: 'string', description: '进度条目 ID' },
          status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'] },
          notes: { type: 'string', description: '更新的备注内容' },
        },
        required: ['progress_id'],
      },
    },
    execute: (input) => {
      const updateData: Record<string, unknown> = {}
      if (input.status) updateData.status = input.status
      if (input.notes) updateData.notes = input.notes
      if (Object.keys(updateData).length === 0) return '没有需要更新的字段'
      progressRepo.update(input.progress_id as string, updateData as any)
      return `进度条目 ${input.progress_id} 已更新`
    },
  },
]
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add 7 agent tools and 5 system prompt templates"
```

---

### Task 4: Agent Service (Claude SDK Integration)

**Files:**
- Create: `src/main/services/agent.service.ts`

**Interfaces:**
- Consumes: `getApiKey()` from Task 2, `AGENT_TOOLS` from Task 3, `buildSystemPrompt` from Task 3
- Produces: `runAgent(params, onEvent)` — runs Claude agent loop and emits events via callback

- [ ] **Step 1: Create src/main/services/agent.service.ts**

```typescript
import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages'
import { getApiKey } from './secrets.service'
import { AGENT_TOOLS, type ToolDefinition } from './agent-tools'
import { buildSystemPrompt } from './prompts'
import { AppError } from '../../renderer/types/errors'

export interface AgentRunParams {
  projectId: string
  conversationId: string
  projectName: string
  message: string
  capability?: string
  context?: {
    selectedText?: string
    filePath?: string
  }
  history?: { role: 'user' | 'assistant'; content: string }[]
}

export interface AgentEventCallback {
  (event: AgentEvent): void
}

export type AgentEvent =
  | { type: 'start'; conversationId: string }
  | { type: 'chunk'; conversationId: string; content: string }
  | { type: 'tool_call'; conversationId: string; tool: string; input: Record<string, unknown> }
  | { type: 'tool_result'; conversationId: string; tool: string; summary: string }
  | { type: 'done'; conversationId: string; content: string }
  | { type: 'error'; conversationId: string; code: string; message: string }

function summarizeToolResult(tool: string, result: string): string {
  const preview = result.length > 200 ? result.substring(0, 200) + '...' : result
  return preview
}

export async function runAgent(params: AgentRunParams, onEvent: AgentEventCallback): Promise<void> {
  const { projectId, conversationId, projectName, message, capability, context, history } = params

  // 1. Read API Key
  const apiKey = await getApiKey()
  if (!apiKey) {
    onEvent({ type: 'error', conversationId, code: 'AI_API_KEY_MISSING', message: '请先在设置中配置 Anthropic API Key' })
    return
  }

  const anthropic = new Anthropic({ apiKey })

  // 2. Build system prompt
  const systemPrompt = buildSystemPrompt(capability, projectName)

  // 3. Build user message with optional context
  let userContent = message
  if (context?.selectedText) {
    userContent = `关于以下选中的内容:\n\`\`\`\n${context.selectedText}\n\`\`\`\n\n${message}`
  }
  if (context?.filePath) {
    userContent = `当前文件: ${context.filePath}\n\n${userContent}`
  }

  // 4. Build message history
  const messages: MessageParam[] = [
    ...(history ?? []).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user' as const, content: userContent },
  ]

  // 5. Extract tool definitions for API
  const toolDefinitions: Tool[] = AGENT_TOOLS.map((t) => t.definition)
  const toolMap = new Map<string, ToolDefinition>(AGENT_TOOLS.map((t) => [t.definition.name, t]))

  onEvent({ type: 'start', conversationId })

  try {
    // 6. Agent loop: send messages, handle tool_use
    let currentMessages = messages
    let loopGuard = 0
    const MAX_LOOPS = 10

    while (loopGuard < MAX_LOOPS) {
      loopGuard++

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: currentMessages,
        tools: toolDefinitions,
      })

      // Check for tool_use
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use')
      const textBlocks = response.content.filter((b) => b.type === 'text')

      if (toolUseBlocks.length === 0) {
        // Final text response — send as chunks
        const finalText = textBlocks.map((b) => (b as any).text).join('')
        // Simulate streaming by sending whole text (SDK streaming at final step possible in future)
        onEvent({ type: 'chunk', conversationId, content: finalText })
        onEvent({ type: 'done', conversationId, content: finalText })
        return
      }

      // Execute tools
      const toolResults: { type: 'tool_result'; tool_use_id: string; content: string }[] = []

      for (const block of toolUseBlocks) {
        const toolUse = block as any
        const toolName = toolUse.name as string
        const toolInput = toolUse.input as Record<string, unknown>

        onEvent({ type: 'tool_call', conversationId, tool: toolName, input: toolInput })

        const toolDef = toolMap.get(toolName)
        let result: string
        try {
          result = await toolDef!.execute(toolInput, projectId)
        } catch (err: any) {
          result = `工具执行错误: ${err.message}`
        }

        onEvent({ type: 'tool_result', conversationId, tool: toolName, summary: summarizeToolResult(toolName, result) })

        toolResults.push({
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: result,
        })
      }

      // Append assistant message + tool results to conversation
      currentMessages = [
        ...currentMessages,
        { role: 'assistant' as const, content: response.content as any },
        { role: 'user' as const, content: toolResults as any },
      ]
    }

    onEvent({ type: 'error', conversationId, code: 'AI_API_ERROR', message: 'Agent 循环次数超限' })
  } catch (err: any) {
    if (err.status === 429) {
      onEvent({ type: 'error', conversationId, code: 'AI_RATE_LIMITED', message: '请求过于频繁，请稍后重试' })
    } else {
      onEvent({ type: 'error', conversationId, code: 'AI_API_ERROR', message: err.message || 'AI 请求失败' })
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: add Claude Agent service with tool-use loop and streaming events"
```

---

### Task 5: Agent IPC Handler + Register in Main

**Files:**
- Create: `src/main/ipc/agent.ipc.ts`
- Modify: `src/main/ipc/index.ts` (add agent handler registration)

- [ ] **Step 1: Create src/main/ipc/agent.ipc.ts**

```typescript
import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { runAgent, type AgentEvent, type AgentRunParams } from '../services/agent.service'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { IpcResult } from '../../renderer/types/errors'

const AGENT_RUN_CHANNEL = 'agent:run'

export function registerAgentHandlers(): void {
  ipcMain.handle(AGENT_RUN_CHANNEL, async (event: IpcMainInvokeEvent, params: AgentRunParams) => {
    // Start agent run in background; events streamed back to renderer
    const sender = event.sender

    const onEvent = (evt: AgentEvent) => {
      sender.send(`agent:${evt.type}`, evt)
    }

    runAgent(params, onEvent).catch((err) => {
      sender.send('agent:error', {
        conversationId: params.conversationId,
        code: 'INTERNAL',
        message: err.message || 'Agent 运行异常',
      })
    })

    // Return immediately; actual response goes via events
    return { ok: true, data: undefined } as IpcResult<void>
  })
}
```

- [ ] **Step 2: Modify src/main/ipc/index.ts**

Add to `registerAllIpcHandlers()`:

```typescript
import { registerAgentHandlers } from './agent.ipc'

export function registerAllIpcHandlers(): void {
  const { registerProjectHandlers } = require('./project.ipc')
  const { registerProgressHandlers } = require('./progress.ipc')
  const { registerFileHandlers } = require('./file.ipc')
  const { registerSettingsHandlers } = require('./settings.ipc')
  const { registerConversationHandlers } = require('./conversation.ipc')

  registerProjectHandlers()
  registerProgressHandlers()
  registerFileHandlers()
  registerSettingsHandlers()
  registerConversationHandlers()
  registerAgentHandlers()
}
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add agent IPC handler with event streaming"
```

---

### Task 6: Conversation Repository + IPC

**Files:**
- Create: `src/main/db/repositories/conversation.repo.ts`, `src/main/ipc/conversation.ipc.ts`
- Modify: `src/main/ipc/index.ts` (add conversation registration — done in Task 5 step 2)

- [ ] **Step 1: Create src/main/db/repositories/conversation.repo.ts**

```typescript
import { v4 as uuid } from 'uuid'
import { getConnection } from '../connection'
import type { Conversation, ConversationMessage } from '../../../renderer/types/conversation'
import { AppError } from '../../../renderer/types/errors'

interface ConversationRow {
  id: string
  project_id: string
  messages: string
  summary: string | null
  created_at: string
}

export class ConversationRepo {
  listByProject(projectId: string): Conversation[] {
    const db = getConnection()
    const rows = db.prepare(
      'SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at DESC'
    ).all(projectId) as ConversationRow[]
    return rows.map(rowToConversation)
  }

  getById(id: string): Conversation | null {
    const db = getConnection()
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined
    return row ? rowToConversation(row) : null
  }

  create(projectId: string): Conversation {
    const db = getConnection()
    const id = uuid()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO conversations (id, project_id, messages, summary, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, projectId, '[]', null, now)
    return this.getById(id)!
  }

  appendMessage(convId: string, message: ConversationMessage): void {
    const db = getConnection()
    const existing = this.getById(convId)
    if (!existing) throw new AppError('PROJECT_NOT_FOUND', '对话不存在')

    const messages = [...existing.messages, message]
    db.prepare('UPDATE conversations SET messages = ? WHERE id = ?').run(JSON.stringify(messages), convId)
  }

  appendMessages(convId: string, newMessages: ConversationMessage[]): void {
    const db = getConnection()
    const existing = this.getById(convId)
    if (!existing) throw new AppError('PROJECT_NOT_FOUND', '对话不存在')

    const messages = [...existing.messages, ...newMessages]
    db.prepare('UPDATE conversations SET messages = ? WHERE id = ?').run(JSON.stringify(messages), convId)
  }

  delete(id: string): void {
    const db = getConnection()
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    projectId: row.project_id,
    messages: JSON.parse(row.messages || '[]'),
    summary: row.summary,
    createdAt: row.created_at,
  }
}

export const conversationRepo = new ConversationRepo()
```

- [ ] **Step 2: Create src/main/ipc/conversation.ipc.ts**

```typescript
import { ipcMain } from 'electron'
import { wrapHandler } from './index'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { ConversationMessage } from '../../renderer/types/conversation'

export function registerConversationHandlers(): void {
  ipcMain.handle('conversation:list', wrapHandler(async (_event, projectId: string) => {
    return conversationRepo.listByProject(projectId)
  }))

  ipcMain.handle('conversation:get', wrapHandler(async (_event, id: string) => {
    return conversationRepo.getById(id)
  }))

  ipcMain.handle('conversation:create', wrapHandler(async (_event, projectId: string) => {
    return conversationRepo.create(projectId)
  }))

  ipcMain.handle('conversation:append', wrapHandler(async (_event, params: { convId: string; message: ConversationMessage }) => {
    return conversationRepo.appendMessage(params.convId, params.message)
  }))

  ipcMain.handle('conversation:delete', wrapHandler(async (_event, id: string) => {
    return conversationRepo.delete(id)
  }))
}
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add conversation repository and IPC handlers"
```

---

### Task 7: Agent + Conversation Preload APIs

**Files:**
- Create: `src/preload/api/agent.api.ts`, `src/preload/api/conversation.api.ts`

- [ ] **Step 1: Create src/preload/api/agent.api.ts**

```typescript
import { ipcRenderer } from 'electron'
import type { IpcResult } from '../../renderer/types/errors'
import type { AgentRunParams, AgentEvent } from '../../renderer/types/conversation'

export const agentApi = {
  run: (params: AgentRunParams): Promise<IpcResult<void>> =>
    ipcRenderer.invoke('agent:run', params),

  onStart: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:start', (_event, data) => cb(data))
  },
  onChunk: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:chunk', (_event, data) => cb(data))
  },
  onToolCall: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:tool_call', (_event, data) => cb(data))
  },
  onToolResult: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:tool_result', (_event, data) => cb(data))
  },
  onDone: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:done', (_event, data) => cb(data))
  },
  onError: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:error', (_event, data) => cb(data))
  },
  removeAll: () => {
    ipcRenderer.removeAllListeners('agent:start')
    ipcRenderer.removeAllListeners('agent:chunk')
    ipcRenderer.removeAllListeners('agent:tool_call')
    ipcRenderer.removeAllListeners('agent:tool_result')
    ipcRenderer.removeAllListeners('agent:done')
    ipcRenderer.removeAllListeners('agent:error')
  },
}
```

- [ ] **Step 2: Create src/preload/api/conversation.api.ts**

```typescript
import { ipcRenderer } from 'electron'
import type { IpcResult } from '../../renderer/types/errors'
import type { Conversation, ConversationMessage } from '../../renderer/types/conversation'

export const conversationApi = {
  list: (projectId: string): Promise<IpcResult<Conversation[]>> =>
    ipcRenderer.invoke('conversation:list', projectId),

  get: (id: string): Promise<IpcResult<Conversation | null>> =>
    ipcRenderer.invoke('conversation:get', id),

  create: (projectId: string): Promise<IpcResult<Conversation>> =>
    ipcRenderer.invoke('conversation:create', projectId),

  append: (convId: string, message: ConversationMessage): Promise<IpcResult<void>> =>
    ipcRenderer.invoke('conversation:append', { convId, message }),

  delete: (id: string): Promise<IpcResult<void>> =>
    ipcRenderer.invoke('conversation:delete', id),
}
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add agent and conversation preload APIs"
```

---

### Task 8: Wire Preload + Update Type Declarations

**Files:**
- Modify: `src/preload/index.ts` (add agent + conversation APIs)
- Modify: `src/renderer/env.d.ts` (add agent + conversation type declarations)

- [ ] **Step 1: Update src/preload/index.ts**

```typescript
import { contextBridge } from 'electron'
import { projectApi } from './api/project.api'
import { progressApi } from './api/progress.api'
import { fileApi } from './api/file.api'
import { settingsApi } from './api/settings.api'
import { agentApi } from './api/agent.api'
import { conversationApi } from './api/conversation.api'

contextBridge.exposeInMainWorld('api', {
  project: projectApi,
  progress: progressApi,
  file: fileApi,
  settings: settingsApi,
  agent: agentApi,
  conversation: conversationApi,
})
```

- [ ] **Step 2: Update src/renderer/env.d.ts**

Add to WindowApi interface:

```typescript
  agent: {
    run: (params: import('./types/conversation').AgentRunParams) => Promise<IpcResult<void>>
    onStart: (cb: (data: import('./types/conversation').AgentStartData) => void) => void
    onChunk: (cb: (data: import('./types/conversation').AgentChunkData) => void) => void
    onToolCall: (cb: (data: import('./types/conversation').AgentToolCallData) => void) => void
    onToolResult: (cb: (data: import('./types/conversation').AgentToolResultData) => void) => void
    onDone: (cb: (data: import('./types/conversation').AgentDoneData) => void) => void
    onError: (cb: (data: import('./types/conversation').AgentErrorData) => void) => void
    removeAll: () => void
  }
  conversation: {
    list: (projectId: string) => Promise<IpcResult<import('./types/conversation').Conversation[]>>
    get: (id: string) => Promise<IpcResult<import('./types/conversation').Conversation | null>>
    create: (projectId: string) => Promise<IpcResult<import('./types/conversation').Conversation>>
    append: (convId: string, message: import('./types/conversation').ConversationMessage) => Promise<IpcResult<void>>
    delete: (id: string) => Promise<IpcResult<void>>
  }
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: wire agent and conversation APIs into preload and type declarations"
```

---

### Task 9: Conversation Zustand Store

**Files:**
- Create: `src/renderer/stores/conversation.store.ts`

- [ ] **Step 1: Create src/renderer/stores/conversation.store.ts**

```typescript
import { create } from 'zustand'
import type { Conversation, ConversationMessage, AgentToolCallData, AgentToolResultData } from '../types/conversation'

interface ConversationStore {
  conversations: Conversation[]
  currentConvId: string | null
  messages: ConversationMessage[]
  isStreaming: boolean
  thinkingSteps: ThinkingStep[]
  streamingText: string

  loadByProject: (projectId: string) => Promise<void>
  createConversation: (projectId: string) => Promise<void>
  setCurrentConv: (id: string) => Promise<void>
  sendMessage: (projectId: string, projectName: string, content: string, capability?: string, selectedText?: string) => Promise<void>
  appendChunk: (content: string) => void
  addThinkingStep: (step: ThinkingStep) => void
  updateThinkingStep: (tool: string, result: string) => void
  finishStreaming: (finalContent: string) => void
  setError: (code: string, message: string) => void
  resetStreaming: () => void
}

export interface ThinkingStep {
  tool: string
  input: Record<string, unknown>
  status: 'running' | 'done'
  result?: string
}

export const useConversationStore = create<ConversationStore>((set, get) => ({
  conversations: [],
  currentConvId: null,
  messages: [],
  isStreaming: false,
  thinkingSteps: [],
  streamingText: '',

  loadByProject: async (projectId) => {
    const result = await window.api.conversation.list(projectId)
    if (result.ok) {
      set({ conversations: result.data })
    }
  },

  createConversation: async (projectId) => {
    const result = await window.api.conversation.create(projectId)
    if (result.ok) {
      const conv = result.data
      set((s) => ({
        conversations: [conv, ...s.conversations],
        currentConvId: conv.id,
        messages: [],
        thinkingSteps: [],
        streamingText: '',
      }))
    }
  },

  setCurrentConv: async (id) => {
    const result = await window.api.conversation.get(id)
    if (result.ok && result.data) {
      set({
        currentConvId: id,
        messages: result.data.messages,
        thinkingSteps: [],
        streamingText: '',
      })
    }
  },

  sendMessage: async (projectId, projectName, content, capability, selectedText) => {
    const state = get()
    let convId = state.currentConvId

    // Auto-create conversation if none active
    if (!convId) {
      const result = await window.api.conversation.create(projectId)
      if (!result.ok) return
      convId = result.data.id
      set({ currentConvId: convId, conversations: [result.data, ...state.conversations] })
    }

    // Add user message locally
    const userMsg: ConversationMessage = {
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    }
    set((s) => ({ messages: [...s.messages, userMsg], isStreaming: true, streamingText: '', thinkingSteps: [] }))

    // Save user message to DB
    await window.api.conversation.append(convId!, userMsg)

    // Register event listeners
    window.api.agent.onChunk((data) => {
      if (data.conversationId === convId) {
        get().appendChunk(data.content)
      }
    })
    window.api.agent.onToolCall((data) => {
      if (data.conversationId === convId) {
        get().addThinkingStep({ tool: data.tool, input: data.input, status: 'running' })
      }
    })
    window.api.agent.onToolResult((data) => {
      if (data.conversationId === convId) {
        get().updateThinkingStep(data.tool, data.summary)
      }
    })
    window.api.agent.onDone((data) => {
      if (data.conversationId === convId) {
        get().finishStreaming(data.content)
      }
    })
    window.api.agent.onError((data) => {
      if (data.conversationId === convId) {
        get().setError(data.code, data.message)
      }
    })

    // Build history (last 20 messages)
    const history = get().messages.slice(-20).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }))

    // Start agent
    await window.api.agent.run({
      projectId,
      conversationId: convId!,
      projectName,
      message: content,
      capability: capability as any,
      context: selectedText ? { selectedText } : undefined,
      history,
    })
  },

  appendChunk: (content) => {
    set((s) => ({ streamingText: s.streamingText + content }))
  },

  addThinkingStep: (step) => {
    set((s) => ({ thinkingSteps: [...s.thinkingSteps, step] }))
  },

  updateThinkingStep: (tool, result) => {
    set((s) => ({
      thinkingSteps: s.thinkingSteps.map((st) =>
        st.tool === tool && st.status === 'running' ? { ...st, status: 'done' as const, result } : st
      ),
    }))
  },

  finishStreaming: async (finalContent) => {
    const state = get()
    const assistantMsg: ConversationMessage = {
      role: 'assistant',
      content: finalContent,
      toolCalls: state.thinkingSteps.map((s) => ({
        tool: s.tool,
        input: s.input,
        result: s.result ?? '',
      })),
      timestamp: new Date().toISOString(),
    }

    set((s) => ({
      messages: [...s.messages, assistantMsg],
      isStreaming: false,
      streamingText: '',
    }))

    // Save to DB
    if (state.currentConvId) {
      await window.api.conversation.append(state.currentConvId, assistantMsg)
    }
  },

  setError: (code, message) => {
    set({ isStreaming: false, streamingText: '' })
  },

  resetStreaming: () => {
    window.api.agent.removeAll()
    set({ isStreaming: false, streamingText: '', thinkingSteps: [] })
  },
}))
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: add conversation Zustand store with streaming and agent event handling"
```

---

### Task 10: ChatMessage + ToolCallCard Components

**Files:**
- Create: `src/renderer/components/ai/ToolCallCard.tsx`, `src/renderer/components/ai/ChatMessage.tsx`

- [ ] **Step 1: Create src/renderer/components/ai/ToolCallCard.tsx**

```tsx
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
```

- [ ] **Step 2: Create src/renderer/components/ai/ChatMessage.tsx**

```tsx
import { Card, Typography, Tag } from 'antd'
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
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add ChatMessage and ToolCallCard components with streaming display"
```

---

### Task 11: ChatInput Component

**Files:**
- Create: `src/renderer/components/ai/ChatInput.tsx`

- [ ] **Step 1: Create src/renderer/components/ai/ChatInput.tsx**

```tsx
import { useState, useRef, useEffect } from 'react'
import { Input, Button, Tag } from 'antd'
import { SendOutlined, HighlightOutlined } from '@ant-design/icons'
import { useConversationStore } from '../../stores/conversation.store'
import { useProjectStore } from '../../stores/project.store'

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
  const textAreaRef = useRef<any>(null)

  const sendMessage = useConversationStore((s) => s.sendMessage)
  const isStreaming = useConversationStore((s) => s.isStreaming)
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const projects = useProjectStore((s) => s.projects)
  const currentProject = projects.find((p) => p.id === currentProjectId)

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

    const projectName = currentProject?.name ?? '未知项目'
    setInput('')

    await sendMessage(
      currentProjectId,
      projectName,
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
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: add ChatInput with /commands, selected text detection, and auto-resize"
```

---

### Task 12: Update AIPanel to Wire Chat UI

**Files:**
- Modify: `src/renderer/components/layout/AIPanel.tsx`

- [ ] **Step 1: Update src/renderer/components/layout/AIPanel.tsx**

```tsx
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
```

- [ ] **Step 2: Install react-markdown**

```bash
cd /home/zuozuo/sf/zzwork && npm install react-markdown
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: replace AIPanel placeholder with full chat UI"
```

---

### Task 13: Settings Modal (API Key Config)

**Files:**
- Create: `src/renderer/components/settings/SettingsModal.tsx`
- Modify: `src/renderer/App.tsx` (add SettingsModal rendering)

- [ ] **Step 1: Create src/renderer/components/settings/SettingsModal.tsx**

```tsx
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
```

- [ ] **Step 2: Modify src/renderer/App.tsx**

Add SettingsModal state and rendering:

```tsx
import { useState } from 'react'
// ... existing imports
import SettingsModal from './components/settings/SettingsModal'

export default function App(): JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <ConfigProvider theme={antdTheme}>
      <AppShell
        projectTree={<ProjectTree />}
        progressPanel={<ProgressPanel />}
        editorTabs={<EditorTabs />}
        editor={<MonacoEditorWrapper />}
        aiPanel={<AIPanel />}
        statusBar={<StatusBar onSettingsClick={() => setSettingsOpen(true)} />}
      />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </ConfigProvider>
  )
}
```

- [ ] **Step 3: Update Settings IPC to handle API Key**

Modify `src/main/ipc/settings.ipc.ts` — add special handling for `anthropic_api_key` key that writes to keychain:

```typescript
import { ipcMain } from 'electron'
import { wrapHandler } from './index'
import { settingsRepo } from '../db/repositories/settings.repo'
import { setApiKey, getApiKey } from '../services/secrets.service'
import { IPC_CHANNELS } from '../../renderer/types/ipc'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, wrapHandler(async (_event, key: string) => {
    if (key === 'has_api_key') {
      const k = await getApiKey()
      return k ? 'true' : 'false'
    }
    return settingsRepo.get(key)
  }))

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, wrapHandler(async (_event, params: { key: string; value: string }) => {
    if (params.key === 'anthropic_api_key') {
      if (params.value) {
        await setApiKey(params.value)
      }
      // Store a flag in SQLite so renderer can check existence without keychain access
      settingsRepo.set('has_api_key', params.value ? 'true' : 'false')
      return
    }
    return settingsRepo.set(params.key, params.value)
  }))

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_ALL, wrapHandler(async () => {
    return settingsRepo.getAll()
  }))
}
```

- [ ] **Step 4: Update StatusBar to accept onSettingsClick prop**

Modify `src/renderer/components/layout/StatusBar.tsx`:

Add `onSettingsClick` to props and add a settings gear icon on the right side:

```tsx
import { SettingOutlined } from '@ant-design/icons'

interface Props {
  onSettingsClick?: () => void
}

export default function StatusBar({ onSettingsClick }: Props): JSX.Element {
  // ... existing code ...

  return (
    <div style={{ /* existing styles */ }}>
      {/* existing left side */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {/* existing right items */}
        <SettingOutlined
          style={{ cursor: 'pointer', opacity: 0.7 }}
          onClick={onSettingsClick}
        />
        <span>{now}</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Update secrets.service.ts to read from settings fallback**

Since keytar may not work on all Linux setups, update `getApiKey()`:

```typescript
import { settingsRepo } from '../db/repositories/settings.repo'

export async function getApiKey(): Promise<string | null> {
  try {
    const key = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME)
    if (key) return key
  } catch { /* keytar unavailable */ }

  // Fallback: read from SQLite (less secure but works everywhere)
  const fallback = settingsRepo.get('anthropic_api_key_fallback')
  return fallback || null
}
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add SettingsModal with API Key configuration and keychain integration"
```

---

### Task 14: Verify Full Build + Smoke Test

**Files:** None (verification only)

- [ ] **Step 1: Verify TypeScript**

```bash
cd /home/zuozuo/sf/zzwork && npx tsc --noEmit -p tsconfig.web.json 2>&1 && npx tsc --noEmit -p tsconfig.node.json 2>&1
```

Expected: Both pass with zero errors.

- [ ] **Step 2: Verify electron-vite build**

```bash
cd /home/zuozuo/sf/zzwork && npx electron-vite build 2>&1
```

Expected: main, preload, renderer all build successfully.

- [ ] **Step 3: Commit (if any lint/type fixes were needed)**

```bash
git add -A && git commit -m "chore: final type/build fixes for Phase 2"
```
