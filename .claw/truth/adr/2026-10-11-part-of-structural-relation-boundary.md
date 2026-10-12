# ADR: 将稳定组成建模为与 is-a 共用父概念槽位的 part-of 结构关系

## Context

仅有 influence 与 specializes 时，建模者容易把“鸟与翅膀”这类局部—整体关系误写成分类、影响，或退化为不具语义的 tag/label。组成关系需要可查询的 canonical 声明，但不应进入正负影响路径、继承或传递推导。另一方面，概念合并会改变规则文字和边界，不能归约成自动搬移连线。

## Decision

新增 `part-of` 结构关系，方向固定为“局部 → 整体”。part-of 与 is-a 共用同一个结构父概念槽位：每个概念至多一个结构父概念，关系类型在 `specializes` 与 `part-of` 之间二选一，因此一个局部只属于一个整体；禁止自连接、组成环以及与 is-a 混合成环（`STRUCTURAL_MULTIPLE_PARENTS`、`STRUCTURAL_CYCLE`）。界面与文档统一称 part-of，不引入 has-a 概念。part-of 不携带 sign、inheritance、端点限定词或 ruleText，不自动产生“局部影响整体”，不做传递闭包，也不进入 impact。node 查询只返回直接整体与直接局部。

part-of 没有连线工具：与 is-a 一样只从子概念的「结构父概念」字段写入，网页在同一个父概念选择器旁提供关系类型切换，已有父概念时切换即一次提交替换结构边；领域层唯一写入口是 `src/domain/graph.mjs` 的 `setStructuralParent`，Agent `rule set-parent` 与项目工具 `isa set` 以可选 `--relation` 指定类型。

规则身份升级为 `(source,target,relation)`，rules v2 的规则 ID 为 `<source>-2-<target>-<relation>`；influence 可与一种结构关系同端点共存，同端点的 specializes 与 part-of 互斥。workspace v14／rules v1 通过一次原子迁移升级为 workspace v15／rules v2，并同步重写所有规则 ID 与固定引用。

建模判定顺序固定为：同一语义复用或 alias；规则参与者子集用 qualifier；真实种类用 is-a；稳定组成用 part-of；真实变化用 influence；纯阅读组织用 tag、scope、目录或视图。概念合并不新增自动命令：先用精确 search/node 与双向 impact 检查，再由建模者逐项改写定义、规则和引用。

## Alternatives

未采用 tag/label 表达可查询组成事实：它们只组织阅读，不参与语义。未采用 specializes 表达 part-of：部件不是整体的一种。未让 part-of 参与 impact 或传递推导：组成不等于影响，直接声明也不承诺任意层级闭包。未实现 concept merge：合并可能要求改写规则文字、限定与概念边界，自动重定向会伪造语义正确性。未让 is-a 与 part-of 各占一个独立槽位：语义上两者正交（部件可以既是某类的一种、又属于某个整体），但二选一换来单一写入口和按子概念 ID 即可覆盖的展示状态，次要归属改用 tag、qualifier 或 influence 表达。未为这次收紧升级协议版本：文件结构不变，只是领域校验变严，旧的多整体或并存资料读取时以明确错误码失败。

## Consequences

Schema、领域校验、迁移、Agent 写入、项目工具、网页投影和查询合同必须同时支持 part-of。结构关系端点不可折叠；part-of 与 is-a 共用 `taxonomyPresentation`：默认隐藏结构边，只在子节点内显示「part-of：整体」标签，按子概念展开后才画虚线边。旧规则 ID 在 v15 迁移中变化，因此所有 mechanic/view 的 pinnedRuleIds 必须同事务更新。建模技能区分普通局部编辑与基础模型重整，后者才执行概念身份与范围覆盖检查。新增结构关系的写入或展示入口时必须复用 `setStructuralParent`、`assertStructuralRelations` 与 `structuralDescendants`，不得再为某一种结构关系单开连线或写入通道。

证据锚点：`src/domain/graph.mjs`、`src/domain/taxonomy-presentation.mjs`、`src/web/app.mjs`、`src/web/glossary.mjs`、`src/server/agent-mutation.mjs`、`src/tools/workspace-tool-source.mjs`；`tests/part-of.test.mjs`、`tests/taxonomy-presentation.test.mjs`、`tests/concept-reference.test.mjs`、`tests/project-open-ui.test.mjs`。

<!-- state: history -->
## Decision evolution

<!-- dated: 2026-10-12 -->
### part-of 曾是允许多整体的独立连线

0.10.1 的初版把 part-of 做成工具栏第四种连线模式（`part-of-tool`），拖线创建，一个局部可以属于多个整体，并始终以独立点状虚线参与排版与路由。用户复核后确认这是做错了：part-of 应当与 is-a 是同一种“特定关系”，在现有父概念交互上切换类型，而不是另一种连线；并且每个概念只保留一个结构父概念。保留这段是因为 0.10.1 已经发布，可能存在多整体或 is-a 与 part-of 并存的资料，它们现在读取时以 `STRUCTURAL_MULTIPLE_PARENTS` 失败，需要作者取舍。
