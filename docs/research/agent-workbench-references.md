# zzwork v1 参考调研：任务工作台 / 环境 / Skills / MCP

日期：2026-11-08
目的：在动手前确定实现路径，避免重复造轮子。所有结论都标注了可借鉴的具体点。

## 1. 参考项目

| 项目 | 量级 | 与 zzwork 的关系 | 可借鉴的具体实现 |
|---|---|---|---|
| [multica-ai/multica](https://github.com/multica-ai/multica) | 20+ agent CLI 适配 | 最接近：agent 当队友、按任务分派、daemon 跑在本机或云端 | **自动探测已安装 CLI**（20+：claude / codex / cursor-agent / copilot / opencode / openclaw / hermes / pi / kimi / kiro-cli / qwen / grok / traecli…）；**每任务独立工作目录**；WebSocket 流式回传；skills 可复用 |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | ~27k stars（注意：README 有 sunsetting 声明，仅作参考） | 看板式 agent 编排 | **每任务 git worktree 隔离**（`git worktree add ... vk/<id>-<slug>`）；**集中 MCP 配置**；任务状态流转驱动 agent 启动 |
| [winfunc/opcode](https://github.com/winfunc/opcode)（原 Claudia） | ~22k stars | Claude Code 的可视化指挥台 | **MCP 管理**：服务注册表 UI、手工添加 / JSON 导入 / 从 Claude Desktop 配置导入、**连接测试**；会话浏览与恢复；agents 系统提示管理 |
| [CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio) | ~53k stars | 多模型桌面客户端 | **MCP 目录 + 逐 agent 绑定**；stdio / SSE / streamable HTTP 三种传输；skills 全局开关 |
| [Cline](https://github.com/cline/cline) / [Roo Code](https://github.com/RooCodeInc/Roo-Code) | 66k / 24k stars | VS Code 内的 agent 扩展 | **扩展内 MCP Marketplace**；逐 server 启用；权限确认流程 |
| [anthropics/skills](https://github.com/anthropics/skills) | 180k+ stars | Agent Skills 规范来源 | **SKILL.md 格式**：一个目录一个 skill，YAML frontmatter 至少 `name` + `description`，正文是指令；`/plugin marketplace` 安装方式 |
| [obra/superpowers](https://github.com/obra/superpowers) | ~296k stars | 社区最大 skill 方法论集合 | skill 的组织方式、触发描述写法 |
| [visulima/find-ai-runner](https://github.com/visulima/visulima)（packages/tooling/find-ai-runner） | 库 | agent 探测 | **探测顺序：环境变量（CLAUDE_PATH 等）→ which/where → 已知路径**（`/opt/homebrew/bin`、`~/.local/bin`、`~/.cargo/bin`…） |
| [kevinelliott/agentmanager](https://github.com/kevinelliott/agentmanager) | CLI | agent 探测 + 安装/升级 | **探测结果带 TTL 缓存**（1 小时），`--refresh` 强制重扫 |
| [milisp/mcp-linker](https://github.com/milisp/mcp-linker) | ~310 stars | MCP 配置同步 | 把一份 MCP 配置同步到多个客户端（Cline / Claude Code / Cursor / VS Code / Codex） |

## 2. 从调研得出的实现决策

### 2.1 执行体探测（环境级）

顺序（参考 find-ai-runner）：

1. 环境变量：`CLAUDE_PATH`、`CODEX_PATH`、`GEMINI_PATH` 等
2. `where`（Windows）/ `which`（POSIX），在目标环境里执行
3. 已知路径兜底：`%APPDATA%\npm`、`~/.local/bin`、`/opt/homebrew/bin`、`~/.cargo/bin`
4. 拿版本：`<cmd> --version`（超时 3s，失败不阻塞）

缓存：探测结果按环境缓存（默认 10 分钟），侧栏「刷新识别」强制重扫（参考 agentmanager 的 `--refresh`）。
WSL / SSH：把同样的探测脚本在目标环境执行（`wsl.exe -d <distro> -- sh -lc "..."`、`ssh host "..."`）。

执行体注册表（v1，按 multica 的清单裁剪）：

```
claude        Claude Code
codex         OpenAI Codex
cursor-agent  Cursor Agent
copilot       GitHub Copilot CLI
opencode      opencode
gemini        Gemini CLI
qwen          Qwen Code
crush         Crush
amp           Amp
kimi          Kimi
zcode         zcode
```

### 2.2 Skills（环境级发现 + 用户添加 + 任务级裁剪）

发现位置（按用户确认）：

```
<env home>/.agents/**/SKILL.md
<env home>/.claude/**/SKILL.md
```

规则（按 anthropics/skills 规范）：

- 一个目录一个 skill，入口固定为 `SKILL.md`
- 解析 YAML frontmatter：`name`（必填）、`description`（必填），缺失则用目录名 + 正文首行兜底
- 去重：按真实路径；同名不同来源都保留，UI 上标 `.agents` / `.claude` / `用户添加`
- 用户添加：目录选择器（把某个含 SKILL.md 的目录加进来），或直接填路径
- 安全提示：社区 skill 质量参差，启用时在 UI 上标来源；不自动执行 skill 内脚本

### 2.3 MCP（环境级配置 + 用户添加 + 任务级裁剪）

兼容三种现成格式（参考 VS Code / Claude 标准）：

| 来源 | 文件 | 顶层键 | 备注 |
|---|---|---|---|
| 项目共享（事实标准） | `<task>/.mcp.json` | `mcpServers` | Claude Code / Cursor / Cline 通用 |
| VS Code 工作区 | `<task>/.vscode/mcp.json` | `servers` | 每项需要 `type` |
| Claude 用户级 | `~/.claude.json` | `mcpServers` | 全局服务 |

传输：`stdio`（command + args + env + cwd）、`http`、`sse`（url + headers）。
用户添加：表单（名称 / 类型 / 命令或 URL / 参数 / 环境变量）或粘贴 JSON 导入（参考 opcode 的 JSON 导入）。
密钥：`${input:...}` / `${env:...}` 保留变量，不在数据库里存明文；需要用户填的存 VS Code SecretStorage。
连接测试：v1 只做进程可启动性检查（stdio 起进程 2s 观察是否立刻退出 / http 发一次初始化请求），不做完整 MCP 握手（留给 v2）。

### 2.4 任务级选择（本次需求的核心）

- 任务信息页展示：**该任务可用的全部 Skills 和 MCP**
  - Skills 来源 = 任务所在环境的发现结果 + 用户全局添加
  - MCP 来源 = 任务所在环境的用户级配置 + 任务目录内 `.mcp.json` / `.vscode/mcp.json` + 用户全局添加
- **默认全选**
- 用户可取消勾选（"裁剪"），选择结果按任务持久化
- 新增的 skill / mcp 默认对已有任务也选中（除非用户显式取消过）
- 实现：存"取消项"而不是"选中项"更贴合默认全选语义：
  - `task_skills(task_id, skill_id, excluded INTEGER)`
  - `task_mcp(task_id, mcp_id, excluded INTEGER)`

### 2.5 交给执行体的方式

- 内置模型聊天：把选中的 skills 正文拼进 system prompt（有 token 预算上限，超出按 description 截断）
- CLI 执行体（Claude Code 等）：v1 生成临时配置
  - MCP：写 `<task>/.zzwork/mcp.json`（`mcpServers` 格式），通过 `--mcp-config` 传给 claude；其他 agent 按其约定
  - Skills：claude 走 `~/.claude/skills`（已是用户目录，天然生效）；额外添加的 skill 用符号链接或复制到任务级 `.claude/skills`
- v1 先做"选择 + 展示 + 内置聊天注入"，CLI 注入在下一轮补齐（避免一次改动过大）

## 3. 风险与注意事项

1. **vibe-kanban 已宣布 sunsetting**：只借鉴思路，不依赖。
2. **skill 安全**：社区统计约 26% 的 skill 存在安全问题；zzwork 只读取文本注入，不执行 skill 自带脚本。
3. **MCP 工具数量**：VS Code 单次请求上限 128 个工具；选中过多 MCP 会挤占上下文，UI 需显示工具数。
4. **token 预算**：skills 正文 + diff 一起注入容易爆；需要"预览将发送的内容"和 token 估算。
5. **密钥**：MCP 的 token 一律走 SecretStorage，不写库、不写日志。
6. **WSL/SSH 探测代价**：SSH 探测要有短超时 + BatchMode，失败不能阻塞 UI。

## 4. v1 落地范围（本次）

- [x] 数据层：environments / skills / mcp_servers / task_skills / task_mcp
- [x] 探测：确定操作系统、home、已装 agent（本地；WSL/SSH 探测沿用现有 runAgent 的环境解析）
- [x] 扫描：`.agents` / `.claude` 下的 SKILL.md；`.mcp.json` / `.vscode/mcp.json` / `~/.claude.json`
- [x] UI：任务信息页的 Skills / MCP 清单，默认全选，可取消并持久化
- [x] 用户添加 skill 目录 / MCP（表单或 JSON 导入）
- [ ] CLI 执行体的 MCP/Skills 注入（下一轮）
- [ ] 连接测试完整握手（下一轮）
