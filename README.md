# zzwork

任务工作台：项目管理 + 环境/执行体管理 + Skills/MCP/模型管理 + AI 会话。

Electron 独立应用，内置 Monaco 编辑器与文件树，任务目录即工作区。

## 快速开始

```bash
cd app
npm install
npm run dev        # 开发模式
npm run build      # 构建产物到 app/out
npm run dist:win   # 打包 Windows（nsis 安装包 + portable + zip，输出 app/release）
npm run dist:mac   # 打包 macOS（dmg + zip，需在 macOS 上执行或走 CI）
```

### 发布

推送 `v*` 标签会触发 GitHub Actions（`.github/workflows/release.yml`）在
`windows-latest` / `macos-latest` 上分别打包并发布到 GitHub Release：

```bash
git tag v0.4.0
git push origin v0.4.0
```

产物：Windows `zzwork-<version>-setup.exe`（另有 portable / zip）、macOS（Apple Silicon）
`zzwork-<version>-mac-arm64.dmg`（另有 zip）。mac 包未签名，首次打开需右键 →「打开」。

## 数据位置

- 业务库：`%APPDATA%\zzwork\data\zzwork.db`（SQLite）
- 全局 Skills：`~/.zzwork/skills/<name>/SKILL.md`
- 全局 MCP：`~/.zzwork/mcp.json`
- 模型 Key：`%APPDATA%\zzwork\secrets.json`（Electron safeStorage 加密，明文只在主进程）
- 对话落盘：`<任务目录>/.zzwork/chat/`

## 结构

| 路径 | 说明 |
|---|---|
| `app/src/main/` | 主进程：IPC、SQLite、执行体、AI、文件系统、密钥 |
| `app/src/core/` | 纯 Node 模块（store / agentRunner / ai / envs / mcpTest） |
| `app/src/preload/` | 安全的 `window.zzwork` 桥 |
| `app/src/renderer/` | 界面：任务树、工作台、Monaco、文件树 |
| `docs/` | 设计文档与调研 |

## 功能

- **项目**：任务树（组/任务，work/code 两型），任务=目录
- **环境**：本机/WSL/SSH，自动探测已安装执行体（claude/zcode/codex/gemini…）
- **Skills**：全局 `~/.zzwork/skills`，远程会话自动同步
- **MCP**：`~/.zzwork/mcp.json` + 任务级 `.mcp.json`，真实握手测试（initialize + tools/list）
- **模型**：提供方（OpenAI 兼容 / Anthropic）→ 多模型两级管理，Key 按提供方加密保存，全库唯一默认模型；任务未指定时跟随默认模型
- **任务工作台**：三固定 tab（任务信息/会话管理/AI 对话），文件 tab 按任务记忆
- **编辑器**：Monaco 语言高亮、脏标记、Ctrl+S 保存
- **文件树**：任务目录内新建/重命名/删除/在资源管理器显示
- **AI 对话**：内置模型流式；CLI 执行体（Claude Code stream-json + `--resume` 会话记忆）
- **版本更新**：启动与每 6 小时检查 GitHub 新版本，标题栏终端按钮左侧出现升级图标，点击一键下载并安装

## 回归测试

```bash
cd app
npm test              # 构建 + 跑全套回归（100+ 个用例）
npm run test:only     # 直接跑（跳过构建）
node test/run.mjs 文件  # 只跑某个用例文件或名称过滤，如 models / 文件
```

测试通过 CDP 驱动真实 Electron 界面，每次运行都在 `app/test/.tmp` 下重新生成隔离环境
（独立的 SQLite、userData、HOME、工作目录），不会触碰真实数据；失败时截图保存到
`app/test/.tmp/shots/`。覆盖：项目/任务树、环境与执行体探测、Skills/MCP（含真实握手）、
模型两级管理、任务信息页、文件树与 Monaco 编辑保存、设置、AI 流式对话（假 SSE 服务与
假 CLI 执行体）、停止生成、文件系统与密钥安全边界。

## 已知问题

- AI 画板（会话管理 tab）目前仅保存草图，未随消息发给模型
- SSH 环境的 MCP 写入走 base64 通道，大配置较慢
