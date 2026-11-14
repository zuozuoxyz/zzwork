# zzwork

以 **VS Code 1.142.0 内核**为基础的任务工作台：项目管理 + 环境/执行体管理 + Skills/MCP/模型管理 + AI 会话。

> 本仓库只包含我们编写的代码（扩展、补丁、脚本、文档）。
> 完整发行版（约 1.7GB，含 VS Code 二进制）由 `build.sh` / `build.ps1` 从官方 zip 组装。

## 快速开始

```bash
# 1. 构建（自动下载 VS Code zip 或指定本地 zip）
./build.sh            # Git Bash / Linux
.\build.ps1           # PowerShell

# 2. 启动
./6d62b1d5da/Code.exe
```

数据位置：
- 业务库：`%APPDATA%\zzwork\data\zzwork.db`（SQLite）
- 全局 Skills：`~/.zzwork/skills/<name>/SKILL.md`
- 全局 MCP：`~/.zzwork/mcp.json`
- VS Code 用户数据：`%APPDATA%\zzwork\`

## 结构

| 路径 | 说明 |
|---|---|
| `6d62b1d5da/resources/app/extensions/zzwork/` | zzwork 内置扩展（随 VS Code 启动加载） |
| `patches/brand.js` | product.json 品牌化（只改值不删键） |
| `patches/patch-workbench.js` | workbench.html 补丁：隐藏登录/AI/更新 UI + 活动栏重排，含 checksum 同步 |
| `patches/zzwork-ui.js` | 注入到 workbench 的运行时脚本 |
| `scripts/` | CDP 自动化验证脚本（截图/DOM/点击） |
| `docs/` | 设计文档与调研 |
| `design/` | HTML 交互原型 |

## 扩展功能（zzwork 内置扩展）

- **项目**：任务树（组/任务，work/code 两型），任务=目录
- **环境**：本机/WSL/SSH，自动探测已安装执行体（claude/zcode/codex/gemini…，PATH + `~/.zcode` 等安装痕迹兜底）
- **Skills**：全局 `~/.zzwork/skills`，远程会话自动同步
- **MCP**：`~/.zzwork/mcp.json` + 任务级 `.mcp.json`，真实握手测试（initialize + tools/list）
- **模型**：OpenAI 兼容 / Anthropic，tab 页配置，Key 存 SecretStorage
- **任务工作台**：三固定 tab（任务信息/会话管理/AI 对话），切换任务整组切换；任务目录自动挂为 VS Code 工作区根（原生 Explorer 新建/重命名/删除）
- **AI 对话**：内置模型聊天流式；CLI 执行体（Claude Code stream-json + 会话记忆）；对话自动落盘 `<任务>/.zzwork/chat/`

## 改动守则（血泪教训）

1. `product.json` **只改值不删键**——删 `auth`/`configurationSync` 等键会导致渲染进程黑屏
2. 改 `out/vs/code/electron-browser/workbench/workbench.html` 后必须同步 `product.json` 里 `checksums` 对应的 SHA-256（见 `patches/patch-workbench.js`），否则启动弹"installation appears to be corrupt"
3. 视图容器贡献点用 `secondarySidebar`（不是 `auxiliarybar`）；扩展容器无法排到原生图标前，顺序由 `zzwork-ui.js` 运行时重排
4. better-sqlite3 需要 electron-v148 预编译：包用 v12.11.1 + 二进制 v12.12.0 prebuild

## 已知问题

- 标题栏/菜单的隐藏靠 DOM 注入，VS Code 大版本升级后需回归验证
- SSH 环境的 MCP 写入走 base64 通道，大配置较慢
- AI 画板（会话管理 tab）目前仅本机保存草图，未发给模型
