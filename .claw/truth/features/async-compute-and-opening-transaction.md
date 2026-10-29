# 可取消后台计算与打开事务

<!-- state: current -->

## 当前行为

- `GraphComputeCoordinator` 拥有后台 Worker 计算生命周期；同一时刻只保留一个 Worker，新请求先 `terminate` 旧 Worker，并以递增 `requestId` 标识任务。网页总览与机制的实时力导向不走该通道，由 `app.mjs` 的 `forceSession` 管理。
- Worker 返回结果只有在 `requestId`、`geometryKey` 与当前几何仍同时匹配时才可提交；失配、Worker 加载/运行错误或响应反序列化失败都会显式失败，不会用旧结果覆盖当前画布。
- 画布、自动排版、路由缓存与几何签名消费同一份显示投影 `src/domain/taxonomy-presentation.mjs` 的 `projectDisplayGraph`（is-a 标签、展开时的虚线边与隐藏的孤立父概念都在这里决定）；`graphGeometryKey`、Worker 载荷与终态几何提交都基于该投影，隐藏节点不参与布局也不产生路线。服务端 Agent `mechanic arrange` 与草稿自动排版按同一规则投影后再排版。
- 正交计算模块继续服务底层调用；网页已移除已存视图打开模式，不能把其 Worker 合同描述为当前网页视图流程。
- 总览与机制图使用 `src/web/force-simulation.mjs` 的 `createForceSimulation`，通过 RAF 分片推进弹簧、精确或 Barnes–Hut 排斥与圆形碰撞，不建立全图距离矩阵。默认每帧计算预算 8ms、非拖动收敛上限 9000ms，时限按活跃帧累计，后台暂停不耗尽时限；每帧最多完成一个物理步，超预算保留生成器游标。拖动固定指针下节点，唤醒所在完整连通分量，以 `alphaTarget=0.3` 保温，不相连分量不重新加热，空间碰撞仍作用于全图；松手目标温度归零并慢冷却。停止条件不保证全局零重叠。无效输入与坐标明确报错，app 回滚该次模拟。
- `app.mjs` 的 `ensureForceLayout` 首屏启动模拟后立即返回，打开遮罩不等待收敛；切图结束旧会话并隔离迟到 tick。首次布局只改运行态，机制拖动连同松手收敛整段一次提交，撤销恢复拖前全部受影响坐标；显式重排自动保存草稿，总览始终只改会话。`beginForceSession`、`finishForceSession`、`commitForcePositions` 是对应锚点。
- `canvas.mjs` 的 `updateForcePositions` 原地更新位置，tick 不重新合成领域图或重建完整 DOM；`requestRasterDraw` 合并同帧绘制。力导向全部倍率使用单张 Canvas2D，不创建逐节点或逐连线 SVG；仅无法创建 2D 上下文时回退 SVG，正交路径保留。`force-geometry.mjs` 即时圆形连线保留方向、符号、平行边和自环，不生成正交缓存，不承诺第三方节点避障或消除全部交叉。
- `app.mjs` 的 `rearrangeForce` 全图显式重排使用 `initialForcePositions` 重新播种；`beginForceSession` 将播种输入与操作前坐标分开，撤销和失败回滚仍恢复操作前画面。
- 显式图文件打开的 loading overlay 由真实读取事务驱动；读取或计算失败后停止动画并保留原错误。网页打开项目及启动恢复先呈现目录，再加载领域数据并进入总览，失败保留目录。连接失败、响应无法解析或超时均明确报错，不推定服务重启而自动刷新；写入响应丢失报告结果待确认，保留草稿供核实。
- 自动排版完成端点交换后只做节点、端点和拐点的同步坐标变换，水平与竖直通道统一保持 `48px` 最小间距，不重复触发全图布线。

## 已验证与限制

单画布收尾记录确认 `npm ci` 成功，12 个相关测试文件 146 项全通过，主要模块语法与 diff 空白检查通过；本轮未运行完整 `npm run check` 或分发检查。1493 节点／2702 关系、1600×960 内置浏览器实测只有 1 Canvas、0 节点 SVG，查找、悬停、真实拖动牵引邻居、方向键、起终点闪烁与全图重排可用。平移绘制 p50/p95/max 为 2.8/5.5/7.1ms，缩放绘制为 4.6/8.9/8.9ms；缩放 RAF 60 样本为 31.2/31.7/62.8ms。旧交接 RAF 7.1/96/177ms 来自无帧率限制无头 Edge，当前基础 RAF 约 31ms，不能计算改善比例。密集图仍有交叉和局部拥挤。相关锚点另含 `tests/geometry-commit.test.mjs`。本次知识维护未重跑测试，源码未提交、未发布。

以下为单画布改造前的阶段验收，不代表本轮重新完成全量或分发检查：

2026-10-29 完成记录确认全量检查 698 项中 696 通过、2 项既有跳过，最后计时修复的模拟及画布回归 34/34 通过，打包检查通过。`tests/force-simulation.test.mjs`、`tests/force-canvas-runtime.test.mjs`、`tests/force-app-state.test.mjs` 与 `tests/force-geometry.test.mjs` 为当前回归锚点。真实规模 1493 节点/2702 边浏览器验证打开、筛选、拖动关联响应和总览零写入；一次打开观测 1.879 秒。小机制验证一次撤销精确恢复整图。帧率采样受浏览器 RAF 暂停影响，不承诺固定 FPS；本次知识维护未重跑测试，源码未提交、未发布。

<!-- state: history -->
## 演进历史

<!-- dated: 2026-10-29 -->
### 静态布局与打开解耦

先前把有限 WebCola Worker 求解当作力导向交互，真实规模首开约 28.1 秒且打开遮罩等待全局计算。当前以拓扑播种和渐进模拟替代网页入口；旧静态模块存在不表示仍用于网页总览。

<!-- state: current -->
## 早期验证范围

2026-09-01 的实现验收报告确认完整测试 `124/124` 通过，并通过浏览器首帧竞态、安装包静态资源和隔离安装检查。当前行为锚点为 `src/web/graph-compute.mjs`、`src/web/graph-compute-worker.js`、`src/web/app.mjs`、`src/web/canvas.mjs` 与 `src/web/layout.mjs`。该记录不代表对真实网络故障、掉电恢复或大规模图性能作出额外承诺。

