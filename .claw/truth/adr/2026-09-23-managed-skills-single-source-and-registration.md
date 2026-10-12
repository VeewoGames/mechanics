# ADR：受管 skill 以安装包为唯一维护源，项目内只保留注册副本

## 背景

没有宿主插件（DSH/Codex MCP）的项目需要在项目内直接使用 Mechanics 能力。为此工具包自带 `skills/mechanics-search`、`skills/mechanics-modeling`、`skills/mechanics-doc` 三个受管 skill 与 `workspace-tools/workspace-tool.mjs`，由 CLI 注册进目标项目。2026-09-03 的收尾计划把「Game-Graph 拥有这些 skill、随包分发、`init` 注册到项目 `.agents/skills/`、冲突显式处理并验收」定为交付标准。

实现落在 `src/server/project-skills.mjs`（2026-09-05 起）：`PROJECT_SKILLS` 与 `PROJECT_TOOLS` 是受管清单；每个 skill 以整目录为准（`mechanics-doc` 额外把 `docs/` 中的引用文档快照进 `references/`）；`preflightProjectSkills` 在创建工作区前只检查路径占用；`registerProjectSkills` 对 `missing` 与 `outdated` 目标整体替换。项目内副本一旦被手工修改，下一次同步就会丢失。

## 决策

- 唯一维护源是安装包内的 `skills/` 与 `workspace-tools/`；项目 `.agents/skills/<name>/` 与 `.mechanics/tools/workspace-tool.mjs` 是注册副本，不反向成为工具真相。需要改 skill 就改包内源并随版本发布。
- 注册判据是「文件集合与内容完全一致」：不存在则安装；完全一致则视为已注册；内容不同或含过期附件则判为 `outdated`，用当前安装包的完整目录替换，路径为暂存目录 → 备份 → 原子改名。旧目录已移至备份后发布失败时尝试回滚到备份；注册失败返回 `PROJECT_SKILL_REGISTRATION_PARTIAL`，报告已安装项与暂存目录。
- 只有路径被普通文件或符号链接占用（包括 `.agents`、`.agents/skills` 本身）才返回 `PROJECT_SKILL_CONFLICT`，在创建工作区前失败，绝不覆盖非受管路径。
- 四个入口共享同一实现与语义：`mech init` 在创建工作区之后注册，该阶段失败以 `INIT_PARTIAL` 报告已创建工作区或已安装 skill；网页显式领域加载/初始化后的后台同步只把结果写进会话的 `projectAssetSync`（失败为 `state: failed` + 错误码 + 服务日志），不阻断会话，修复后重开可重试；`mech sync` 等待同步完成；`mech migrate-project --execute` 在协议链式升级后注册并清理旧产品名的 skill。
- 项目单文件工具的 JSON 合同版本由 `src/tools/workspace-tool-source.mjs` 的 `WORKSPACE_TOOL_CONTRACT_VERSION` 单点维护，guide 与草稿 open/validate/save 共用；生成产物及注册副本不成为第二个版本 owner。版本不一致必须在源修复、重建并同步，不能放宽调用方版本门禁或跳过保存校验。这条合同独立于文件 Schema 与查询语义版本。
- 同步来源是当前运行服务/CLI 所来自的安装包，不联网升级；`.mechanics/tools` 是基础设施，不计入工作区文件树 revision，避免一次后台同步把正在编辑的草稿变成 revision 冲突。
- Windows 目录发布、备份与回滚遇到 `EPERM`、`EACCES` 或 `EBUSY` 时，按有限退避重试（最多 8 次，等待间隔递增）；其他错误仍显式失败；旧目录尚未移动时的占用重试耗尽可进入上述逐文件退路，其余阶段或退路失败保留部分注册诊断，不把无界重试当成功。
- 受管文件清单比较采用确定性路径排序，避免跨平台排序差异把内容一致的注册副本误判为过期。

## 取舍

- **项目直接链接或引用安装包 `skills/`，不复制**：未采用。项目会随 CLI 升级被动改变，无插件宿主也拿不到离线可读的稳定目录；注册副本让项目自包含。
- **内容不同即冲突并拒绝同步**：未采用。一次 skill 内容更新会让项目永久卡在冲突上，只能靠用户手工删除；受管目录本就不允许自定义修改，且无法可靠区分「用户改的」与「包变旧的」。
- **逐文件或三方合并**：不采用内容合并。整目录替换仍是首选；仅在旧目录尚未移动且改名因 `EPERM`、`EACCES` 或 `EBUSY` 失败时，允许按包内清单逐文件原子替换并回读，随后删除过期受管文件，不删除被占用目录。此退路不保证多文件整体原子性，真实失败仍报 `PROJECT_SKILL_REGISTRATION_PARTIAL`，不能声称整目录回滚。
- **静默覆盖、不报告**：未采用。替换是可观察事件，失败必须显式区分路径冲突（`PROJECT_SKILL_CONFLICT`）、注册中断（`PROJECT_SKILL_REGISTRATION_PARTIAL`）、初始化阶段失败（`INIT_PARTIAL`）与后台同步失败（`projectAssetSync`）。

## 影响

- 项目内受管目录不接受自定义修改；这条政策与「先同步再使用」并列，是本决策的直接代价。
- 新增受管 skill 或工具只需进 `PROJECT_SKILLS` / `PROJECT_TOOLS`，四个入口自动获得同一注册与替换语义。
- 旧产品名下的 skill 由 `mech migrate-project` 在注册后清理；迁移仍只消费 `migration.mjs` 的单一链，不产生第二套升级路径。
- 回归覆盖 `tests/project-lifecycle.test.mjs` 的「受管 assets 路径冲突不会阻断项目会话」用例（占用路径 → 后台同步 `failed` / `PROJECT_SKILL_CONFLICT`，项目仍可读写，修复后重开恢复 `current`），以及 `scripts/check-package.mjs` 的 `initSkillRegistration` 隔离安装验收。

证据锚点：`src/server/project-skills.mjs`、`src/server/workspace-commands.mjs`、`src/server/project-manager.mjs`、`src/server/migrate-legacy-project.mjs`、`src/server/cli.mjs`；`tests/project-lifecycle.test.mjs`、`scripts/check-package.mjs`；`docs/更新与升级.md`。
