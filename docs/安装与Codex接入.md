# Mechanics 安装与 Codex 接入

本页是当前 `@veewo/mechanics` 的安装、项目初始化与 Codex MCP 配置入口。历史 `game-graph` 命令和 `.game-graph` 路径不适用于此页。

## 安装与初始化

需要 Node.js 24 或更高版本。

```powershell
npm install -g @veewo/mechanics
mech init <项目目录>
```

`init` 默认使用文件夹名作为显示名，自动生成符合协议的稳定 ID，也可用 `--name` 和 `--id` 显式指定。它创建项目内 `.mechanics` 工作区，并安装受管的 `mechanics-search`、`mechanics-modeling` 与 `mechanics-doc` skills 和 `.mechanics/tools/workspace-tool.mjs`。重复执行会补齐、修复这些受管资产，不覆盖已有项目名称、ID、概念、规则或图文件。网页选择文件夹时自动执行同样的准备，无需额外填写初始化表单。已有领域会话的后续资产更新仍可在后台进行；也可运行 `mech sync` 等待同步完成。失败明确提示，重新打开可重试。更新来源是当前运行服务的安装包，不会联网升级。

## 启动网页编辑器

在项目目录中启动，并让 CLI 自动向上定位该项目的 `.mechanics`：

```powershell
mech web
```

也可以从任意目录明确指定项目与端口：

```powershell
mech web --project <项目目录> --port 4319
```

浏览器打开 CLI 输出的本地地址。省略 `--project` 时，网页以空项目状态启动；选择空文件夹即可自动初始化并打开。已有项目自动修复受管工具后加载数据；核心数据损坏时仍保留目录浏览并明确报告错误，不用空定义覆盖用户文件。

## 配置 Codex MCP Apps

在目标项目的 `.codex/config.toml` 中加入：

```toml
[mcp_servers.mechanics-render]
command = "mech"
args = ["mcp", "render"]
cwd = "<包含 .mechanics 的项目绝对路径>"
startup_timeout_sec = 20
tool_timeout_sec = 60
```

重启 Codex 后，工具名为 `mechanics_render_concepts`。它只接收已经消歧的稳定概念 ID，不接收项目路径：

```ts
mechanics_render_concepts({ conceptIds: ["stamina", "dodge", "damage"] })
```

服务在启动时按 `cwd` 向上定位并固定 `.mechanics` 工作区；修改配置中的 `cwd` 后必须重启 Codex。工具调用成功、收到结构化结果、以及宿主实际显示 widget 分别验证。

## 继续阅读

- MCP widget 合同与兼容性：`Codex MCP Apps.md`
- 查询与受约束写入：`Agent查询接口.md`
- 文件格式与版本：`文件协议.md`
- 架构、路径与安全边界：`架构设计.md`
