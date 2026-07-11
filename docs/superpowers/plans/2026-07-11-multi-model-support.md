# Multi-Model Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor AI module to support multiple model providers (Anthropic + OpenAI-compatible), allowing users to add/configure models via base URL + API key, with per-model keychain storage.

**Architecture:** Agent service refactored to backend interface (AnthropicBackend / OpenAICompatibleBackend), model configs in SQLite + keychain, SettingsModal rewritten as model list manager, ChatInput gains model selector dropdown.

**Tech Stack:** openai SDK (new), existing @anthropic-ai/sdk, keytar, better-sqlite3

## Global Constraints

- No tests (deferred per design decision)
- API Key stored in system keychain per model (key = `zzwork:model:{id}`)
- Backends output identical unified event stream
- Tool definitions unchanged (agent-tools.ts untouched)
- System prompts unchanged (prompts.ts untouched)
- At least one model must exist at all times
- First launch: auto-insert 2 preset models (Claude Sonnet + GPT-4o)

---

### Task 1: ModelConfig Types + openai SDK

**Files:**
- Create: `src/renderer/types/model.ts`
- Modify: `package.json` (add openai)

**Produces:** Type definitions, npm dependency

- [ ] **Step 1: Create src/renderer/types/model.ts**

```typescript
export interface ModelConfig {
  id: string
  name: string
  type: 'anthropic' | 'openai_compatible'
  baseUrl: string
  modelId: string
  isDefault: boolean
  createdAt: string
}

// Excludes apiKey — that's only in keychain
export interface ModelConfigDTO {
  name: string
  type: 'anthropic' | 'openai_compatible'
  baseUrl: string
  apiKey?: string       // only in create/update, never returned
  modelId: string
  isDefault?: boolean
}

export interface CreateModelDTO {
  name: string
  type: 'anthropic' | 'openai_compatible'
  baseUrl: string
  apiKey: string
  modelId: string
  isDefault?: boolean
}

export interface UpdateModelDTO {
  name?: string
  type?: 'anthropic' | 'openai_compatible'
  baseUrl?: string
  apiKey?: string
  modelId?: string
  isDefault?: boolean
}
```

- [ ] **Step 2: Install openai SDK**

```bash
cd /home/zuozuo/sf/zzwork && npm install openai
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add ModelConfig types and openai SDK dependency"
```

---

### Task 2: Model Repository + DB Migration

**Files:**
- Create: `src/main/db/migrations/002-models.sql`
- Create: `src/main/db/repositories/model.repo.ts`
- Modify: `src/main/db/connection.ts` (run migration)

**Interfaces:**
- Produces: `modelRepo` with list/create/update/delete/setDefault/getById/getDefault, seeding 2 presets on empty

- [ ] **Step 1: Create src/main/db/migrations/002-models.sql**

```sql
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'openai_compatible',
  base_url TEXT NOT NULL,
  model_id TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Create src/main/db/repositories/model.repo.ts**

```typescript
import { v4 as uuid } from 'uuid'
import { getConnection } from '../connection'
import type { ModelConfig, CreateModelDTO, UpdateModelDTO } from '../../../renderer/types/model'
import { AppError } from '../../../renderer/types/errors'

interface ModelRow {
  id: string
  name: string
  type: string
  base_url: string
  model_id: string
  is_default: number
  created_at: string
}

function rowToModel(row: ModelRow): ModelConfig {
  return {
    id: row.id,
    name: row.name,
    type: row.type as ModelConfig['type'],
    baseUrl: row.base_url,
    modelId: row.model_id,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
  }
}

const PRESETS: CreateModelDTO[] = [
  {
    name: 'Claude Sonnet',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    modelId: 'claude-sonnet-4-20250514',
    apiKey: '',
    isDefault: true,
  },
  {
    name: 'GPT-4o',
    type: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    modelId: 'gpt-4o',
    apiKey: '',
    isDefault: false,
  },
]

export class ModelRepo {
  list(): ModelConfig[] {
    const db = getConnection()
    const rows = db.prepare('SELECT * FROM models ORDER BY created_at ASC').all() as ModelRow[]
    return rows.map(rowToModel)
  }

  getById(id: string): ModelConfig | null {
    const db = getConnection()
    const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow | undefined
    return row ? rowToModel(row) : null
  }

  getDefault(): ModelConfig | null {
    const db = getConnection()
    const row = db.prepare('SELECT * FROM models WHERE is_default = 1 LIMIT 1').get() as ModelRow | undefined
    return row ? rowToModel(row) : null
  }

  create(dto: CreateModelDTO): ModelConfig {
    const db = getConnection()
    const id = uuid()
    const now = new Date().toISOString()
    const isDefault = dto.isDefault ?? false

    if (isDefault) {
      db.prepare('UPDATE models SET is_default = 0').run()
    }

    db.prepare(
      'INSERT INTO models (id, name, type, base_url, model_id, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, dto.name, dto.type, dto.baseUrl, dto.modelId, isDefault ? 1 : 0, now)

    return this.getById(id)!
  }

  update(id: string, dto: UpdateModelDTO): ModelConfig {
    const db = getConnection()
    const existing = this.getById(id)
    if (!existing) throw new AppError('PROJECT_NOT_FOUND', '模型不存在')

    if (dto.isDefault) {
      db.prepare('UPDATE models SET is_default = 0').run()
    }

    const fields: string[] = []
    const values: any[] = []
    if (dto.name !== undefined) { fields.push('name = ?'); values.push(dto.name) }
    if (dto.type !== undefined) { fields.push('type = ?'); values.push(dto.type) }
    if (dto.baseUrl !== undefined) { fields.push('base_url = ?'); values.push(dto.baseUrl) }
    if (dto.modelId !== undefined) { fields.push('model_id = ?'); values.push(dto.modelId) }
    if (dto.isDefault !== undefined) { fields.push('is_default = ?'); values.push(dto.isDefault ? 1 : 0) }

    if (fields.length > 0) {
      values.push(id)
      db.prepare(`UPDATE models SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }

    return this.getById(id)!
  }

  delete(id: string): void {
    const db = getConnection()
    const models = this.list()
    if (models.length <= 1) throw new AppError('PROJECT_NOT_FOUND', '至少保留一个模型')
    db.prepare('DELETE FROM models WHERE id = ?').run(id)
    // If deleted model was default, set first remaining as default
    const remaining = this.list()
    if (!remaining.some((m) => m.isDefault)) {
      db.prepare('UPDATE models SET is_default = 1 WHERE id = ?').run(remaining[0].id)
    }
  }

  setDefault(id: string): ModelConfig {
    const db = getConnection()
    db.prepare('UPDATE models SET is_default = 0').run()
    db.prepare('UPDATE models SET is_default = 1 WHERE id = ?').run(id)
    return this.getById(id)!
  }

  seedIfEmpty(): void {
    const db = getConnection()
    const count = db.prepare('SELECT COUNT(*) as c FROM models').get() as { c: number }
    if (count.c === 0) {
      for (const preset of PRESETS) {
        const id = uuid()
        const now = new Date().toISOString()
        db.prepare(
          'INSERT INTO models (id, name, type, base_url, model_id, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, preset.name, preset.type, preset.baseUrl, preset.modelId, preset.isDefault ? 1 : 0, now)
      }
    }
  }
}

export const modelRepo = new ModelRepo()
```

- [ ] **Step 3: Modify src/main/db/connection.ts**

In `runMigrations()`, after running 001-init.sql, also run:

```typescript
// Run 002-models migration
const migration2Paths = [
  join(__dirname, '../db/migrations/002-models.sql'),
  join(__dirname, '../../main/db/migrations/002-models.sql'),
  join(__dirname, '../../../src/main/db/migrations/002-models.sql'),
]
for (const p of migration2Paths) {
  if (existsSync(p)) {
    sql = readFileSync(p, 'utf-8')
    db.exec(sql)
    break
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add model repository with presets and migration"
```

---

### Task 3: Refactor Secrets Service

**Files:**
- Modify: `src/main/services/secrets.service.ts`

**Interfaces:**
- Produces: `getModelKey(id)` / `setModelKey(id, key)` / `deleteModelKey(id)` replacing old single-API-key functions

- [ ] **Step 1: Rewrite src/main/services/secrets.service.ts**

```typescript
import keytar from 'keytar'
import { settingsRepo } from '../db/repositories/settings.repo'

const SERVICE_NAME = 'zzwork'
const KEY_PREFIX = 'model:'

function keyName(modelId: string): string {
  return `${KEY_PREFIX}${modelId}`
}

export async function getModelKey(modelId: string): Promise<string | null> {
  try {
    const key = await keytar.getPassword(SERVICE_NAME, keyName(modelId))
    if (key) return key
  } catch { /* keytar unavailable */ }
  // SQLite fallback (encrypted at rest by app in future Phase)
  const fallback = settingsRepo.get(`model_key_${modelId}`)
  return fallback || null
}

export async function setModelKey(modelId: string, key: string): Promise<void> {
  try {
    await keytar.setPassword(SERVICE_NAME, keyName(modelId), key)
  } catch {
    // Fallback to SQLite when keychain unavailable
    settingsRepo.set(`model_key_${modelId}`, key)
  }
}

export async function deleteModelKey(modelId: string): Promise<void> {
  try {
    await keytar.deletePassword(SERVICE_NAME, keyName(modelId))
  } catch { /* ignore */ }
  settingsRepo.set(`model_key_${modelId}`, '')
}
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "refactor: replace single API key with per-model keychain storage"
```

---

### Task 4: Model IPC Handlers

**Files:**
- Create: `src/main/ipc/model.ipc.ts`
- Modify: `src/main/ipc/index.ts` (register model handlers)
- Modify: `src/renderer/types/ipc.ts` (add model IPC channels)

- [ ] **Step 1: Create src/main/ipc/model.ipc.ts**

```typescript
import { ipcMain } from 'electron'
import { wrapHandler } from './index'
import { modelRepo } from '../db/repositories/model.repo'
import { getModelKey, setModelKey, deleteModelKey } from '../services/secrets.service'
import type { CreateModelDTO, UpdateModelDTO } from '../../renderer/types/model'

export function registerModelHandlers(): void {
  ipcMain.handle('model:list', wrapHandler(async () => {
    return modelRepo.list()
  }))

  ipcMain.handle('model:get', wrapHandler(async (_event, id: string) => {
    return modelRepo.getById(id)
  }))

  ipcMain.handle('model:create', wrapHandler(async (_event, dto: CreateModelDTO) => {
    const apiKey = dto.apiKey
    const model = modelRepo.create(dto)
    if (apiKey) await setModelKey(model.id, apiKey)
    return model
  }))

  ipcMain.handle('model:update', wrapHandler(async (_event, params: { id: string; data: UpdateModelDTO }) => {
    const { id, data } = params
    if (data.apiKey !== undefined) {
      if (data.apiKey) await setModelKey(id, data.apiKey)
      else await deleteModelKey(id)
    }
    return modelRepo.update(id, data)
  }))

  ipcMain.handle('model:delete', wrapHandler(async (_event, id: string) => {
    await deleteModelKey(id)
    return modelRepo.delete(id)
  }))

  ipcMain.handle('model:set-default', wrapHandler(async (_event, id: string) => {
    return modelRepo.setDefault(id)
  }))
}
```

- [ ] **Step 2: Modify src/renderer/types/ipc.ts**

Add constants:

```typescript
export const IPC_CHANNELS = {
  // ... existing ...
  MODEL_LIST:       'model:list',
  MODEL_GET:        'model:get',
  MODEL_CREATE:     'model:create',
  MODEL_UPDATE:     'model:update',
  MODEL_DELETE:     'model:delete',
  MODEL_SET_DEFAULT:'model:set-default',
} as const
```

Add to IpcChannelMap:

```typescript
[IPC_CHANNELS.MODEL_LIST]:        { request: void; response: ModelConfig[] }
[IPC_CHANNELS.MODEL_GET]:         { request: string; response: ModelConfig | null }
[IPC_CHANNELS.MODEL_CREATE]:      { request: CreateModelDTO; response: ModelConfig }
[IPC_CHANNELS.MODEL_UPDATE]:      { request: { id: string; data: UpdateModelDTO }; response: ModelConfig }
[IPC_CHANNELS.MODEL_DELETE]:      { request: string; response: void }
[IPC_CHANNELS.MODEL_SET_DEFAULT]: { request: string; response: ModelConfig }
```

- [ ] **Step 3: Modify src/main/ipc/index.ts**

Add `registerModelHandlers` import and call.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add model CRUD IPC handlers with per-model keychain integration"
```

---

### Task 5: Model Preload API + Type Declarations

**Files:**
- Create: `src/preload/api/model.api.ts`
- Modify: `src/preload/index.ts`, `src/renderer/env.d.ts`

- [ ] **Step 1: Create src/preload/api/model.api.ts**

```typescript
import { ipcRenderer } from 'electron'
import type { IpcResult } from '../../renderer/types/errors'
import type { ModelConfig, CreateModelDTO, UpdateModelDTO } from '../../renderer/types/model'

export const modelApi = {
  list: (): Promise<IpcResult<ModelConfig[]>> =>
    ipcRenderer.invoke('model:list'),
  get: (id: string): Promise<IpcResult<ModelConfig | null>> =>
    ipcRenderer.invoke('model:get', id),
  create: (dto: CreateModelDTO): Promise<IpcResult<ModelConfig>> =>
    ipcRenderer.invoke('model:create', dto),
  update: (id: string, data: UpdateModelDTO): Promise<IpcResult<ModelConfig>> =>
    ipcRenderer.invoke('model:update', { id, data }),
  delete: (id: string): Promise<IpcResult<void>> =>
    ipcRenderer.invoke('model:delete', id),
  setDefault: (id: string): Promise<IpcResult<ModelConfig>> =>
    ipcRenderer.invoke('model:set-default', id),
}
```

- [ ] **Step 2: Modify src/preload/index.ts**

Add `model: modelApi` to the exposed API object.

- [ ] **Step 3: Modify src/renderer/env.d.ts**

Add `model` member to `WindowApi` interface with matching types.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add model preload API and type declarations"
```

---

### Task 6: AI Backend Interface + Anthropic Backend

**Files:**
- Create: `src/main/services/backends/backend.interface.ts`
- Create: `src/main/services/backends/anthropic.backend.ts`

**Interfaces:**
- Produces: `AIBackend` interface, `AnthropicBackend` class

- [ ] **Step 1: Create src/main/services/backends/backend.interface.ts**

```typescript
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages'
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages'

export interface AgentEvent {
  type: 'start' | 'chunk' | 'tool_call' | 'tool_result' | 'done' | 'error'
  conversationId: string
  content?: string
  tool?: string
  input?: Record<string, unknown>
  summary?: string
  code?: string
  message?: string
}

export type AgentEventCallback = (event: AgentEvent) => void

export interface AIBackend {
  chat(
    messages: MessageParam[],
    tools: Tool[],
    systemPrompt: string,
    onEvent: AgentEventCallback
  ): Promise<string>
}
```

- [ ] **Step 2: Create src/main/services/backends/anthropic.backend.ts**

```typescript
import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages'
import { getModelKey } from '../secrets.service'
import type { ModelConfig } from '../../../renderer/types/model'
import { AppError } from '../../../renderer/types/errors'
import type { AIBackend, AgentEventCallback } from './backend.interface'

export class AnthropicBackend implements AIBackend {
  constructor(private model: ModelConfig) {}

  async chat(
    messages: MessageParam[],
    tools: Tool[],
    systemPrompt: string,
    onEvent: AgentEventCallback
  ): Promise<string> {
    const apiKey = await getModelKey(this.model.id)
    if (!apiKey) throw new AppError('AI_API_KEY_MISSING', `模型 "${this.model.name}" 未配置 API Key`)

    const anthropic = new Anthropic({ apiKey, baseURL: this.model.baseUrl })

    const response = await anthropic.messages.create({
      model: this.model.modelId,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools,
    })

    // Process response: extract tool_use blocks and text
    const toolUses = response.content.filter((b) => b.type === 'tool_use')
    const texts = response.content.filter((b) => b.type === 'text')

    for (const tu of toolUses) {
      const block = tu as any
      onEvent({
        type: 'tool_call',
        conversationId: '',
        tool: block.name,
        input: block.input,
      })
    }

    const finalText = texts.map((t: any) => t.text).join('')
    return finalText
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add AI backend interface and Anthropic adapter"
```

---

### Task 7: OpenAI Compatible Backend

**Files:**
- Create: `src/main/services/backends/openai.backend.ts`

- [ ] **Step 1: Create src/main/services/backends/openai.backend.ts**

```typescript
import OpenAI from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions'
import { getModelKey } from '../secrets.service'
import type { ModelConfig } from '../../../renderer/types/model'
import { AppError } from '../../../renderer/types/errors'
import type { AIBackend, AgentEventCallback } from './backend.interface'
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages'

export class OpenAICompatibleBackend implements AIBackend {
  constructor(private model: ModelConfig) {}

  async chat(
    messages: any[],
    tools: any[],
    systemPrompt: string,
    onEvent: AgentEventCallback
  ): Promise<string> {
    const apiKey = await getModelKey(this.model.id)
    if (!apiKey) throw new AppError('AI_API_KEY_MISSING', `模型 "${this.model.name}" 未配置 API Key`)

    const client = new OpenAI({
      apiKey,
      baseURL: this.model.baseUrl,
    })

    // Convert tools to OpenAI format
    const openaiTools: ChatCompletionTool[] = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))

    // Build OpenAI messages with system prompt
    const openaiMessages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string'
          ? m.content
          : (m.content as any[])?.map((b: any) =>
              b.type === 'text' ? { type: 'text' as const, text: b.text }
              : b.type === 'tool_use'
                ? { type: 'function_call' as const, id: b.id, function: { name: b.name, arguments: JSON.stringify(b.input) } }
                : { type: 'text' as const, text: JSON.stringify(b) }
            ),
      })),
    ]

    const response = await client.chat.completions.create({
      model: this.model.modelId,
      messages: openaiMessages,
      tools: openaiTools,
      max_tokens: 4096,
    })

    const choice = response.choices[0]
    const msg = choice.message

    // Emit tool calls
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let input: Record<string, unknown> = {}
        try {
          input = JSON.parse(tc.function.arguments)
        } catch { /* ignore parse errors */ }

        onEvent({
          type: 'tool_call',
          conversationId: '',
          tool: tc.function.name,
          input,
        })
      }
    }

    return msg.content || ''
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: add OpenAI-compatible backend adapter"
```

---

### Task 8: Refactor Agent Service

**Files:**
- Modify: `src/main/services/agent.service.ts`

**Interfaces:**
- Consumes: `AIBackend` from Task 6, `modelRepo` from Task 2, `getModelKey` from Task 3
- Produces: `runAgent(params, onEvent)` — router to correct backend

- [ ] **Step 1: Rewrite src/main/services/agent.service.ts**

```typescript
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages'
import { modelRepo } from '../db/repositories/model.repo'
import { AGENT_TOOLS } from './agent-tools'
import { buildSystemPrompt } from './prompts'
import { AnthropicBackend } from './backends/anthropic.backend'
import { OpenAICompatibleBackend } from './backends/openai.backend'
import type { AIBackend, AgentEvent, AgentEventCallback } from './backends/backend.interface'
import { AppError } from '../../renderer/types/errors'

export type { AgentEvent, AgentEventCallback }

export interface AgentRunParams {
  projectId: string
  conversationId: string
  modelId: string
  projectName: string
  message: string
  capability?: string
  context?: { selectedText?: string; filePath?: string }
  history?: { role: 'user' | 'assistant'; content: string }[]
}

function getBackend(model: import('../../renderer/types/model').ModelConfig): AIBackend {
  if (model.type === 'anthropic') return new AnthropicBackend(model)
  return new OpenAICompatibleBackend(model)
}

function summarizeToolResult(result: string): string {
  return result.length > 200 ? result.substring(0, 200) + '...' : result
}

export async function runAgent(params: AgentRunParams, onEvent: AgentEventCallback): Promise<void> {
  const { projectId, conversationId, modelId, projectName, message, capability, context, history } = params

  // 1. Load model config
  const model = modelRepo.getById(modelId)
  if (!model) {
    onEvent({ type: 'error', conversationId, code: 'PROJECT_NOT_FOUND', message: '模型不存在' })
    return
  }

  const backend = getBackend(model)

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

  // 5. Extract tool definitions
  const toolDefinitions: Tool[] = AGENT_TOOLS.map((t) => t.definition)
  const toolMap = new Map(AGENT_TOOLS.map((t) => [t.definition.name, t]))

  onEvent({ type: 'start', conversationId })

  try {
    // 6. Agent loop
    let currentMessages = messages
    let loopGuard = 0
    const MAX_LOOPS = 10

    while (loopGuard < MAX_LOOPS) {
      loopGuard++

      const textResponse = await backend.chat(currentMessages, toolDefinitions, systemPrompt, (evt) => {
        onEvent({ ...evt, conversationId })
      })

      // Check if backend returned a final text response (no tool calls needed)
      // Re-chat to detect tool_use — for OpenAI backend, check if the response has tool_calls
      // For Anthropic backend, re-query if there were tool_use blocks

      // Actually, we need to check: did the backend call tool_call events?
      // The simplest approach: call backend.chat, get the response.
      // If the response signals tool_use (via events), execute them and loop.

      // For simplicity: run the backend once. If it emitted tool_call events,
      // fetch the tool results and update messages, then run again.

      // Since our backends currently do one-shot (not looped internally),
      // we rebuild the loop around the tool events

      // After backend.chat returns, check if tool calls were made
      // by tracking them. We'll use a simpler approach: backend returns
      // both text and signals whether tool calls are pending.

      // For now, backend returns text. Let's check if the text is empty
      // and tool calls exist by running the chat in a tool-aware way.

      // Simplified: just return the text and let the caller handle
      if (textResponse) {
        onEvent({ type: 'chunk', conversationId, content: textResponse })
        onEvent({ type: 'done', conversationId, content: textResponse })
        return
      }

      // No text = tool calls were emitted; execute them
      // Re-run to get final response
    }

    if (loopGuard >= MAX_LOOPS) {
      onEvent({ type: 'error', conversationId, code: 'AI_API_ERROR', message: 'Agent 循环次数超限' })
    }
  } catch (err: any) {
    if (err instanceof AppError) {
      onEvent({ type: 'error', conversationId, code: err.code, message: err.message })
    } else if (err.status === 429) {
      onEvent({ type: 'error', conversationId, code: 'AI_RATE_LIMITED', message: '请求过于频繁，请稍后重试' })
    } else {
      onEvent({ type: 'error', conversationId, code: 'AI_API_ERROR', message: err.message || 'AI 请求失败' })
    }
  }
}
```

- [ ] **Step 2: Update agent.ipc.ts**

Change `AgentRunParams` interface: add `modelId: string`, import from agent.service.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "refactor: agent service uses backend interface with model routing"
```

---

### Task 9: Agent Service — Full Tool-Use Loop

**Files:**
- Modify: `src/main/services/agent.service.ts`
- Modify: `src/main/services/backends/anthropic.backend.ts`
- Modify: `src/main/services/backends/openai.backend.ts`

**Note:** This task completes the agent loop. The backends from Tasks 6-7 return a single response. This task adds proper tool_use detection and the multi-turn loop.

- [ ] **Step 1: Update AIBackend interface**

Add return type that signals pending tool calls:

```typescript
export interface AIBackend {
  chat(
    messages: MessageParam[],
    tools: Tool[],
    systemPrompt: string,
    onEvent: AgentEventCallback
  ): Promise<{ text: string; toolUses: ToolUseBlock[] }>
}

export interface ToolUseBlock {
  id: string
  name: string
  input: Record<string, unknown>
}
```

- [ ] **Step 2: Update AnthropicBackend**

Return tool_use blocks from response:

```typescript
async chat(...): Promise<{ text: string; toolUses: ToolUseBlock[] }> {
  // ... create anthropic client, call messages.create ...
  const response = await anthropic.messages.create({ ... })

  const toolUses: ToolUseBlock[] = []
  const texts: string[] = []

  for (const block of response.content) {
    if (block.type === 'tool_use') {
      const tu = block as any
      toolUses.push({ id: tu.id, name: tu.name, input: tu.input })
      onEvent({ type: 'tool_call', conversationId: '', tool: tu.name, input: tu.input })
    } else if (block.type === 'text') {
      texts.push((block as any).text)
    }
  }

  return { text: texts.join(''), toolUses }
}
```

- [ ] **Step 3: Update OpenAICompatibleBackend**

Return tool_use blocks:

```typescript
async chat(...): Promise<{ text: string; toolUses: ToolUseBlock[] }> {
  // ... create client, call chat.completions.create ...
  const response = await client.chat.completions.create({ ... })
  const msg = response.choices[0].message

  const toolUses: ToolUseBlock[] = []
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(tc.function.arguments) } catch {}
      toolUses.push({ id: tc.id, name: tc.function.name, input })
      onEvent({ type: 'tool_call', conversationId: '', tool: tc.function.name, input })
    }
  }

  return { text: msg.content || '', toolUses }
}
```

- [ ] **Step 4: Update agent.service.ts loop**

```typescript
while (loopGuard < MAX_LOOPS) {
  loopGuard++
  const { text, toolUses } = await backend.chat(currentMessages, toolDefinitions, systemPrompt, onEvent)

  if (toolUses.length === 0) {
    // Final response
    onEvent({ type: 'chunk', conversationId, content: text })
    onEvent({ type: 'done', conversationId, content: text })
    return
  }

  // Execute tools
  const toolResults: { type: 'tool_result'; tool_use_id: string; content: string }[] = []
  for (const tu of toolUses) {
    const toolDef = toolMap.get(tu.name)
    let result: string
    try {
      result = await toolDef!.execute(tu.input, projectId)
    } catch (err: any) {
      result = `工具执行错误: ${err.message}`
    }
    onEvent({ type: 'tool_result', conversationId, tool: tu.name, summary: summarizeToolResult(result) })
    toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result })
  }

  // Build next messages: assistant response + tool results
  const assistantContent = toolUses.map((tu, i) => ({
    type: 'tool_use' as const,
    id: tu.id,
    name: tu.name,
    input: tu.input,
  }))

  currentMessages = [
    ...currentMessages,
    { role: 'assistant' as const, content: assistantContent as any },
    { role: 'user' as const, content: toolResults as any },
  ]
}
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: complete tool-use agent loop with backend-agnostic execution"
```

---

### Task 10: Conversation Store + ChatInput + Agent IPC — Add modelId

**Files:**
- Modify: `src/renderer/stores/conversation.store.ts`
- Modify: `src/renderer/components/ai/ChatInput.tsx`
- Modify: `src/main/ipc/agent.ipc.ts`

- [ ] **Step 1: Update conversation.store.ts**

Add `currentModelId` and pass it to `sendMessage`:

```typescript
interface ConversationStore {
  // ... existing ...
  currentModelId: string | null
  setModelId: (id: string) => void
  sendMessage: (projectId: string, projectName: string, content: string, capability?: string, selectedText?: string) => Promise<void>
}
```

In `create` initial value: `currentModelId: null`

Add action:
```typescript
setModelId: (id) => set({ currentModelId: id }),
```

In `sendMessage`, change agent.run call to include `modelId`:

```typescript
await window.api.agent.run({
  projectId,
  conversationId: convId!,
  modelId: get().currentModelId || '',
  projectName,
  message: content,
  capability: capability as any,
  context: selectedText ? { selectedText } : undefined,
  history,
})
```

On store init, load default model:

```typescript
// In sendMessage: if no currentModelId, auto-load default
if (!get().currentModelId) {
  const models = await window.api.model.list()
  if (models.ok) {
    const def = models.data.find(m => m.isDefault) || models.data[0]
    if (def) set({ currentModelId: def.id })
  }
}
```

- [ ] **Step 2: Update agent.ipc.ts**

Accept `modelId` in the handler params.

- [ ] **Step 3: Update ChatInput.tsx**

Add model selector dropdown above the input area:

```tsx
import { Select } from 'antd'

// State
const [models, setModels] = useState<ModelConfig[]>([])
const currentModelId = useConversationStore((s) => s.currentModelId)
const setModelId = useConversationStore((s) => s.setModelId)

// Load models
useEffect(() => {
  window.api.model.list().then(r => { if (r.ok) setModels(r.data) })
}, [])

// In JSX, above capability tags:
<Select
  value={currentModelId || undefined}
  onChange={setModelId}
  size="small"
  style={{ width: 180, marginBottom: 8 }}
  options={models.map(m => ({
    value: m.id,
    label: `${m.isDefault ? '● ' : ''}${m.name}`,
  }))}
  placeholder="选择模型"
/>
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add modelId routing in agent, store, and ChatInput selector"
```

---

### Task 11: SettingsModal Rewrite

**Files:**
- Modify: `src/renderer/components/settings/SettingsModal.tsx`

- [ ] **Step 1: Rewrite SettingsModal.tsx**

Complete rewrite as model list manager with add/edit modal. Key structure:

```tsx
import { useState, useEffect } from 'react'
import { Modal, Button, List, Tag, Popconfirm, Select, Input, message } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, StarOutlined, StarFilled } from '@ant-design/icons'
import type { ModelConfig, CreateModelDTO, UpdateModelDTO } from '../../types/model'

// Component state:
// - models: ModelConfig[]
// - editingModel: ModelConfig | null
// - formOpen: boolean
// - form: { name, type, baseUrl, apiKey, modelId }
// - saving: boolean

// Functions:
// - loadModels(): window.api.model.list()
// - handleCreate(): window.api.model.create(dto)
// - handleUpdate(): window.api.model.update(id, dto)
// - handleDelete(id): window.api.model.delete(id)
// - handleSetDefault(id): window.api.model.setDefault(id)

// Render:
// - List of models, each with: name, type tag, baseUrl, modelId, default star, edit/delete buttons
// - Add button at bottom
// - Edit/Add modal with form fields
```

Full implementation (~120 lines) with:
- Model list showing name, type badge, URL, model ID, default star
- Delete confirmation (prevent deleting last model)
- Add/Edit form modal
- Form validation

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "refactor: rewrite SettingsModal as model list manager"
```

---

### Task 12: Seed Presets + Wire Main Init

**Files:**
- Modify: `src/main/index.ts` (call modelRepo.seedIfEmpty on startup)

- [ ] **Step 1: Update src/main/index.ts**

After `registerAllIpcHandlers()`, add:

```typescript
import { modelRepo } from './db/repositories/model.repo'
// ...
app.whenReady().then(() => {
  getConnection() // ensure DB + migrations run
  modelRepo.seedIfEmpty()
  registerAllIpcHandlers()
  createWindow()
  // ...
})
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: seed preset models on first launch"
```

---

### Task 13: Verify Build + Final Cleanup

**Files:** None (verification only)

- [ ] **Step 1: Verify TypeScript**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
```

Expected: Zero errors.

- [ ] **Step 2: Verify electron-vite build**

```bash
npx electron-vite build
```

Expected: main, preload, renderer all build successfully.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "chore: final type and build fixes for multi-model support"
```
