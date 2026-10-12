# CLI、工作区与文件保存

<!-- state: current -->
## 当前行为

- Node.js 24+ 本地 CLI（bin `mech`，包名 `@veewo/mechanics`）提供 `init/web/validate/catalog/root`、只读 `agent guide/scopes/search/graph/node/impact` 与受约束 `agent concept/rule` mutation。`src/server/cli.mjs` 的顶层帮助从包元数据读取产品版本，工作区协议版本单独取 `CURRENT_WORKSPACE_VERSION`（当前 v15）；`mech --version` 返回包版本，不把协议 v15 当产品版本。子命令帮助与迁移说明应随协议更新，避免旧版本示例被误作当前命令。源码和 npm 包独立于游戏引擎、宿主资产和 claw-kit；npm 分发不代表仓库授权条款变更。
- 发布后本机验收是独立于 npm 发布和项目 `mech sync` 的步骤：从 registry 回读已发布的精确版本，以 `npm install -g @veewo/mechanics@<版本>` 替换全局 CLI，并核查实际解析目录与安装来源；`link:`、`file:`、`workspace:` 或工具仓库源码路径均不算正式包。单独的 `mech --version` 数字不足以证明来源；发行已完成而本机安装失败时，分别报告 registry 与本地状态，不用源码链接冒充更新。操作顺序见 `docs/更新与升级.md`。
- 每个游戏项目固定使用 `<project>/.mechanics` 保存 canonical。`init` 可在现有普通项目内创建该目录，也可创建项目根，并把包内 `mechanics-search`、`mechanics-modeling`、`mechanics-doc` 注册到项目 `.agents/skills/`，把 `workspace-tool.mjs` 同步到 `.mechanics/tools/`；已有 `.mechanics` 时拒绝覆盖。建立领域会话或初始化项目后在后台更新这些受管资产，不等待同步完成即可使用页面；仅浏览目录不触发同步。
- 三个受管 skill（`mechanics-search`、`mechanics-modeling`、`mechanics-doc`）的唯一维护源在工具包 `skills/`，项目 `.agents/skills/` 只是注册副本，不反向成为工具真相。目标不存在时安装；文件集合与内容完全相同时视为已注册；目录内容不同或含过期附件时，用当前安装包的完整目录整体替换（暂存目录 → 备份 → 原子改名），不合并自定义内容，也不是联网升级；旧目录尚未移动而改名因 `EPERM`、`EACCES` 或 `EBUSY` 失败时，允许逐文件原子替换并回读，再删除过期受管文件，不删除被占用目录。这一退路不保证多文件整体原子性，失败仍报告部分完成。只有路径被普通文件或符号链接占用才在创建工作区前返回 `PROJECT_SKILL_CONFLICT`，不覆盖用户文件；暂存发布、备份和回滚遇到 Windows `EPERM`、`EACCES` 或 `EBUSY` 瞬时占用时执行有限退避重试（最多 8 次，等待间隔递增）；除上述旧目录未移动时的逐文件退路外，重试耗尽或遇到其他错误仍返回 `PROJECT_SKILL_REGISTRATION_PARTIAL`，报告已安装项与暂存目录。源与目标文件清单以确定性路径顺序比较，避免跨平台排序差异造成已同步内容被误判过期。`init` 在创建工作区之后注册，该阶段失败以 `INIT_PARTIAL` 显式报告已创建工作区或已安装 skill；网页显式领域加载触发的后台同步失败只记在该会话的 `projectAssetSync`（`state: failed` 与错误码）并写服务日志，不阻断会话，修复后重开可重试。
- 显式 `--project` 优先；`validate/catalog/root` 省略时向上寻找最近 `.mechanics/workspace.json`。`web` 可空项目启动并从网页打开或初始化项目。目录浏览独立于领域会话；领域候选加载成功后才切换，`projectGeneration` 阻止旧页面写入新项目。
- 正式协议只接受工作区 v15、definitions v7、rules v2、mechanic v9、view v5；mechanism 与 view 必填 `taxonomyPresentation`。`readWorkspace` 只把当前版本当作可写合同，读取路径不为缺失字段补默认值。显式领域加载时，所有仍有迁移路径的旧协议（v7–v14）在创建 store 前按预览→执行自动逐级升级（每一跳原子提交并回读，任何一跳失败零部分写入），失败返回迁移错误且不返回部分工作区；v11/v12 因缺少必填展示状态没有只读兼容模型，v7–v10 的直接读取仍按核心拓扑兼容模式呈现（结构编辑以 `COMPATIBILITY_READ_ONLY` 拒绝）。目录递归发现普通 `*.mechanic.json`、`*.view.json`；不保存第二份清单。隐藏条目与 node_modules 排除，普通目录包括空目录参与发现。服务内存 `files` 按 `(kind,id)` 对应当前路径；两种文件可同 ID，移动后重读可定位。
- 唯一定义入口由 `workspace.json.definitions` 指定。目录浏览 `POST /api/project/directory` 只枚举路径，返回 `navigationOnly`、files、directories 与逐路径 diagnostics，不解析 JSON、不初始化、不迁移、不建立领域会话或写入能力；链接不跟随，深度/数量边界仍执行。核心损坏不阻断这一目录投影。显式领域加载仍严格校验核心；`readWorkspace` 默认严格失败，`isolateResources:true` 则把机制/视图的字节读取、JSON 解析及资源校验失败纳入 `resourceDiagnostics`，返回 `workspaceState: degraded`，不伪造缺失资源或放宽保存门禁。路径穿越、内部链接、嵌套工作区等安全边界不因资源隔离而取消。
- 命名视图 `.view.json` 保存机制 ID、折叠与组合位置，源规则只读；新建和展示编辑写 activeLayerId:null，非空旧值只用于还原历史位置。`lastView` 只存 `{viewId}`；单机制最近打开使用单成员内联形式，旧多图内联状态只读保留直到明确保存或放弃。重开读最新来源，不保存合并副本；历史 compositions 仍校验，不删除或自动转换。
- 项目内单文件工具的维护源是 `src/tools/workspace-tool-source.mjs`，构建产物为 `workspace-tools/workspace-tool.mjs`，项目副本按受管资产同步。`WORKSPACE_TOOL_CONTRACT_VERSION` 是工具 JSON 合同版本的唯一 owner（当前 8），`guide`、`draft open`、`draft validate` 与 `draft save` 输出共用它；该版本不同于工作区 Schema 和查询语义版本。发现版本不一致应修复源、重建并同步受管副本，不降低 skill 门禁、伪造返回版本或绕过保存校验。
- 服务仅绑定回环地址；静态资源精确白名单。新增供浏览器加载的领域模块时，须同步 `src/server/http.mjs` 的路由白名单和 `scripts/check-package.mjs` 的分发清单、隔离安装静态请求门禁；源码中存在模块不代表发行包浏览器可访问。API 没有 session、Bearer 或 Origin 授权并支持跨源 JSON，仍校验 Host、JSON、路径、projectGeneration、整体/资源 revision 和锁。任何知道项目绝对路径且能访问本机端口的网页或进程都可能写入，只用于可信本机开发环境。不能通过直接打开 file:// 页面运行编辑器。
- 网页资源与 Schema 一样在 `startServer` 时一次性读入并固定（`src/server/http.mjs` 的 `servedAssets`）：进程启动后更新源码不会改变已经提供的内容，前端改动必须重启服务才能生效。`mech web` 遇到端口被占用时先请求 `POST /api/server/handoff`，让旧的 Mechanics 进程完成响应后自行关闭再重试绑定，旧版 Windows 进程由 `src/server/cli.mjs` 的 `terminateLegacyWindowsMechanics` 显式终止；1 秒内未释放端口以 `MECHANICS_HANDOFF_TIMEOUT` 失败，被非 Mechanics 进程占用的端口仍原样报 `EADDRINUSE`。因此新起的同端口实例会停掉先前的 Mechanics 服务，这是设计行为而非崩溃。
- Agent mutation 只允许概念 create/update/delete 与规则 add/update/delete，使用 definitions 或目标 mechanic 的资源 revision；在线模式还要求当前 projectGeneration。Agent 不能修改 `agentLocked`、视图、布局、机制元数据或工作区设置。锁定概念拒绝 Agent 修改/删除，写入后同队列发布 catalog；发布失败明确返回 canonical 是否已提交，调用方不得自动重试。
- `src/server/store.mjs` 负责单工作区进程锁、写入队列、整体与按资源的 revision、候选引用校验和回读。`src/server/workspace.mjs` 的版本戳按路径、剔除展示字段后的语义内容与普通目录集合计算；写入只在本次涉及资源的语义版本改变时冲突，结构操作仍要求整体版本不变。受管工具目录 `.mechanics/tools` 是基础设施而非工作区语义，不计入文件树版本，否则一次后台资产同步会让正在编辑的草稿变成冲突。冲突保留草稿，不自动重试或强制覆盖。
- 已有文件通过同目录临时文件替换；新建以硬链接原子发布完整文件且拒绝同名覆盖。不支持该操作的文件系统明确失败；失败可能留下空目录，提交后回读失败报告结果待确认。
- 迁移是唯一的正文升级路径：`mech migrate --from <旧版本> --to <新版本>` 逐级预览后显式执行，`mech migrate-project --execute` 一次完成旧根、旧 skill 与协议的链式升级；不保留旧产品名、旧文件类型、旧后缀或旧 Schema。可自动升级的版本（v7–v14）只在显式领域加载时自动迁移，目录浏览不触发；没有迁移路径的版本不会被当前协议改写文件。

## 验证边界

2026-08-31 的 `npm run check` 通过 44 项测试，包含视图文件/HTTP、ID、移动/revision、断引用、迁移、候选打开与失败队列，以及 0.4.0 单机制导航、旧记录和坐标接管、成员反向保存和显式折叠修复。0.4.0 通过 `npm run check:package`：31 个分发文件，Windows 隔离安装、命令 shim、资料子目录启动和静态模块成功；包不含 `.claw` 与游戏私有资料。后续版本须重新验收。

2026-09-07：`npm run check` 通过 360 项测试；`npm run check:package` 验证 74 个发行文件的隔离安装、CLI、内置 skill 注册、查询、离线/在线写入与网页服务。`game-graph@0.7.0` 已由 npm registry 回读，并以 `npx -y game-graph@0.7.0 --version` 独立验证为 `0.7.0`。发行流程见仓库根目录 `DISTRIBUTION.md`。

2026-09-29 的 0.9.1 发布记录：发布前的隔离包静态请求发现新领域模块未列入浏览器资源白名单，补充路由和包检查后，`npm ci`、`npm run check`（595 通过、2 跳过）、`npm run check:package`（93 文件）通过。main 发行提交 `7e64c3c` 与 `v0.9.1` 标签已推送；registry 精确 integrity 与本地一致，官方全局 CLI 已安装为 0.9.1。DSH web profile 插件依赖当时仍为 0.9.0，进程未重启，不代表当前 GUI 已加载 0.9.1；宿主目标图尚无真实打开验收。这是版本限定的完成记录，而非未来安装状态保证。

不承诺任意外部编辑器的原子 CAS、多文件事务、掉电恢复、网络共享盘或多人协作。未实现文件监听、跨文件撤销和相机持久化。测试只使用临时工作区，不写用户正式资料、不调用宿主游戏运行时。

实现入口：`src/server/workspace-commands.mjs`、`workspace.mjs`、`files.mjs`、`store.mjs` 和 `http.mjs`；操作见 `docs/CLI与工作区.md` 和 `docs/编辑器使用说明.md`。

<!-- state: history -->
## 演进历史

<!-- dated: 2026-10-12 -->
### 显示名元信息与工具合同版本一致性

目录浏览后另行通过 `POST /api/project/metadata` 安全回读 `workspace.json.name`，坏元信息显式失败但不阻断目录；目录接口仍不解析 JSON、不建立领域会话。工具指南曾返回合同 8，草稿 open 与 validate/save summary 硬编码 7，现统一到版本常量 8，`tests/workspace-tool-save.test.mjs` 固定四入口一致性。完成记录确认合同修复后 46 项相关测试和最终安装包检查通过，最终 tarball 经授权安装并同步目标项目受管资产，源与项目工具副本哈希一致、实际 guide 返回 8；不把这次本机部署写成 registry 发布。被引用的旧草稿已不存在，核验返回 ENOENT，未重建或提交游戏 canonical，也不能据此推断外部 Agent 已提交。

<!-- dated: 2026-10-12 -->
### 目录浏览独立与占用目录同步退路

网页打开项目和启动恢复改为独立目录投影，图加载与附属同步仅在显式领域路径触发。机制/视图字节读取及 JSON 解析进入资源隔离边界；核心严格失败、写入门禁与结果待确认合同保持。Windows 旧 skill 目录尚未移动时允许逐文件原子更新，不保证多文件整体原子性。完成记录确认 `npm run check` 615 通过、2 跳过，`check:package` 通过；真实项目目录打开与隔离坏核心/坏图恢复验收成功，未修改游戏 canonical JSON。该记录不代表 npm registry 发布或所有平台验收。

<!-- dated: 2026-09-23 -->
### 受管 skill 的冲突语义更正为整目录替换

2026-09-05 起，本文与 `docs/CLI与工作区.md` 把「同名 skill 内容不同」记成返回 `PROJECT_SKILL_CONFLICT` 且「绝不覆盖」，但同日落地的 `src/server/project-skills.mjs` 一直把内容不同或含过期附件的受管目录判为 `outdated` 并用安装包完整目录替换，`PROJECT_SKILL_CONFLICT` 只用于普通文件或符号链接占用路径。本次知识收尾按实现更正：`preflightProjectSkills` 在创建工作区前只做占用检查（`init` 经 `src/server/workspace-commands.mjs` 调用），`registerProjectSkills` 对 `missing` 与 `outdated` 目标用暂存目录 + 备份 + 原子改名替换，中途失败报 `PROJECT_SKILL_REGISTRATION_PARTIAL`。注册副本的维护归属与「整目录替换而非逐文件合并」的取舍见 ADR「受管 skill 的唯一维护源与注册副本」；项目内 `.agents/skills/` 不接受自定义修改。
