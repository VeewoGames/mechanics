# ADR：将稳定组成建模为独立 part-of 结构关系

## 背景

仅有 influence 与 specializes 时，建模者容易把“鸟与翅膀”这类局部—整体关系误写成分类、影响，或退化为不具语义的 tag/label。组成关系需要可查询的 canonical 声明，但不应进入正负影响路径、继承或传递推导。另一方面，概念合并会改变规则文字和边界，不能归约成自动搬移连线。

## 决策

新增 `part-of` 结构关系，方向固定为“局部 → 整体”。一个局部可以直接属于多个整体；禁止自连接和组成环。part-of 不携带 sign、inheritance、端点限定词或 ruleText，不自动产生“局部影响整体”，不做传递闭包，也不进入 impact。node 查询只返回直接整体与直接局部。

规则身份升级为 `(source,target,relation)`，rules v2 的规则 ID 为 `<source>-2-<target>-<relation>`；influence 可与一种结构关系同端点共存，同端点的 specializes 与 part-of 互斥。workspace v14／rules v1 通过一次原子迁移升级为 workspace v15／rules v2，并同步重写所有规则 ID 与固定引用。

建模判定顺序固定为：同一语义复用或 alias；规则参与者子集用 qualifier；真实种类用 is-a；稳定组成用 part-of；真实变化用 influence；纯阅读组织用 tag、scope、目录或视图。概念合并不新增自动命令：先用精确 search/node 与双向 impact 检查，再由建模者逐项改写定义、规则和引用。

## 取舍

未采用 tag/label 表达可查询组成事实：它们只组织阅读，不参与语义。未采用 specializes 表达 part-of：部件不是整体的一种。未让 part-of 参与 impact 或传递推导：组成不等于影响，直接声明也不承诺任意层级闭包。未实现 concept merge：合并可能要求改写规则文字、限定与概念边界，自动重定向会伪造语义正确性。

## 影响

Schema、领域校验、迁移、Agent 写入、项目工具、网页投影和查询合同必须同时支持 part-of。结构关系端点不可折叠；part-of 以独立虚线和标签呈现。旧规则 ID 在 v15 迁移中变化，因此所有 mechanic/view 的 pinnedRuleIds 必须同事务更新。建模技能区分普通局部编辑与基础模型重整，后者才执行概念身份与范围覆盖检查。
