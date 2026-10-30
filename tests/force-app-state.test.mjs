import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { compose } from '../src/domain/graph.mjs';
import { isEndpointProjection } from '../src/domain/endpoint-projection.mjs';
import { createOverviewState, reconcileOverviewState, composeOverview, forceTopologyKey } from '../src/web/overview.mjs';
import { GraphCanvas } from '../src/web/canvas.mjs';
import { initialForcePositions } from '../src/web/force-simulation.mjs';
import { createRouteCache, restoreRouteCache, graphGeometryKey } from '../src/web/route-cache.mjs';
import { graphPositions } from '../src/web/mechanic-files.mjs';
import { projectEndpointQualifiers } from '../src/domain/endpoint-projection.mjs';

const app = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
function section(start, end) {
  const from = app.indexOf(start), to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, '应用函数边界不存在：' + start);
  return app.slice(from, to);
}

// 执行应用函数与画布回调本身；模拟器边界只提供可控的逐帧、收敛、失败事件。
const functions = [
  section('let preferredGraphMode =', 'let hoverTooltipsEnabled ='),
  section('const dirty =', '// 画布、布局'),
  section('function overviewState()', 'let referenceSession'),
  section('async function saveDraft(', 'function edit('),
  section('function edit(', 'function undo('),
  section('function undo(', 'function field('),
  section('function activateOverview(', 'async function changeOverviewSelection('),
  section('async function removeSelection(', 'async function addNode('),
  section('function rememberForcePositions(', 'const compute = new GraphComputeCoordinator'),
  section('async function autoLayout(', 'async function applyBrowsingWorkspace('),
  section('async function commitSettledGeometry(', 'const canvas = new GraphCanvas'),
  'const dragCallbacks = ({ ' + section('  forceDragStart:', '  move: positions =>') + ' });',
  'const positionCallbacks = ({ ' + section('  move: positions =>', '  zoom: value =>') + ' });',
].join('\n');

const graph = { nodes: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }],
  edges: [{ id: 'a-to-b', source: 'a', target: 'b', relation: 'influence', sign: 1 }] };
const savedPositions = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } };
const runtimePositions = { a: { x: 80, y: 160 }, b: { x: 420, y: 240 } };
const arrangedPositions = { a: { x: 140, y: 200 }, b: { x: 520, y: 320 } };

function harness({ overview = false, preferences = new Map() } = {}) {
  const controls = new Map(), calls = { writes: [], requests: [], reads: [], errors: [], renders: 0, frames: 0, fits: 0, engines: [] };
  const mechanic = { id: 'mechanic-a', name: '测试机制', focusNodeIds: ['a', 'b'], pinnedRuleIds: ['a-to-b'], positions: structuredClone(savedPositions) };
  const workspace = { projectRoot: 'G:/测试项目', projectSessionToken: 'session-a', projectGeneration: 1,
    manifest: { name: '测试项目' }, definitions: { nodes: structuredClone(graph.nodes), positions: {} },
    rules: { rules: structuredClone(graph.edges) }, mechanics: [mechanic],
    files: [{ kind: 'mechanic', id: mechanic.id, path: 'mechanics/first.mechanic.json' }] };
  const context = vm.createContext({
    workspace, browserWorkspace: workspace, graph: structuredClone(graph),
    screen: overview ? 'overview' : 'mechanic', activeId: overview ? null : mechanic.id,
    draft: overview ? undefined : structuredClone(mechanic), baseline: overview ? undefined : structuredClone(mechanic),
    graphReturnScreen: overview ? 'overview' : 'mechanic', opening: false, arranging: false, forceSession: null,
    geometryEpoch: 0, history: [], future: [], selection: null,
    forceLayouts: new Map(), forceHistory: new WeakMap(), overviewStates: new Map(), cameras: new Map(),
    uiPreference: (key, fallback) => preferences.has(key) ? preferences.get(key) : fallback,
    saveUiPreference: (key, value) => preferences.set(key, value),
    sidebarState: { page: overview ? 'overview' : 'mechanics' },
    clone: structuredClone, json: JSON.stringify, compose, isEndpointProjection,
    createOverviewState, reconcileOverviewState, composeOverview, forceTopologyKey, initialForcePositions,
    createRouteCache, restoreRouteCache, graphGeometryKey, graphPositions, projectEndpointQualifiers, implicitPositions: new Map(),
    busy: () => false, projectKey: () => context.workspace.projectRoot.toLowerCase(),
    contextKey: () => context.workspace.projectRoot.toLowerCase() + '/' + (context.screen === 'overview' ? 'overview' : 'mechanic/' + context.activeId),
    displayGraphOf: () => context.graph,
    projection: () => structuredClone(context.forceLayouts.get(context.contextKey())?.positions ?? context.draft?.positions ?? savedPositions),
    compute: { cancel() {} },
    createForceSimulation: callbacks => {
      const engine = {
        callbacks, positions: {}, stopped: false, draggedIds: [],
        start(input) {
          this.input = structuredClone(input); this.positions = structuredClone(input.positions);
          if (calls.failNextStart) { const error = calls.failNextStart; calls.failNextStart = null; throw error; }
        },
        stop() { this.stopped = true; },
        getPositions() { return structuredClone(this.positions); },
        dragStart(ids) { this.draggedIds = [...ids]; },
        drag(ids, positions) { Object.assign(this.positions, structuredClone(positions)); this.lastDrag = { ids, positions }; },
        dragEnd() { this.released = true; },
        tick(positions) { this.positions = structuredClone(positions); callbacks.onTick({ positions: structuredClone(positions) }); },
        settle(positions = this.positions) { this.positions = structuredClone(positions); callbacks.onSettle({ positions: structuredClone(positions) }); },
        fail(error) { callbacks.onError(error); },
      };
      calls.engines.push(engine); return engine;
    },
    canvas: {
      graph: structuredClone(graph), positions: structuredClone(overview ? savedPositions : runtimePositions),
      forceFrameVersion: 1, camera: { x: 0, y: 0, scale: 1 },
      cancel() {}, setMode() {}, selectedIds: () => [], fit() { calls.fits++; },
      routed: new Map(), primeRoutes(graph, positions, routes) { this.routed = routes; },
      updateForcePositions(positions, version = this.forceFrameVersion) {
        if (version !== this.forceFrameVersion) return false;
        Object.assign(this.positions, structuredClone(positions)); calls.frames++; return true;
      },
    },
    saveFailure: { blocked: false, reset() { this.blocked = false; } },
    guard: async () => true, rememberCamera() {}, restoreCamera() {}, renderProjectTabs() {}, updateStatus() {},
    render: async () => { calls.renders++; context.canvas.positions = context.projection(); return true; },
    $: id => { if (!controls.has(id)) controls.set(id, {}); return controls.get(id); },
    write: async (operation, options) => {
      calls.writes.push({ options: structuredClone(options), arranging: context.arranging }); return operation('revision-a');
    },
    api: async (path, body) => { calls.requests.push({ path, body: structuredClone(body) }); return context.workspace; },
    apiForProject: async (project, path, body) => { calls.reads.push({ path, body }); return project; },
    dialog: async () => { throw new Error('只读总览不应进入删除确认'); },
    showError: error => calls.errors.push(error),
  });
  vm.runInContext(functions, context);
  if (!overview) context.forceLayouts.set(context.contextKey(), { positions: structuredClone(runtimePositions), topology: forceTopologyKey(graph) });
  return { context, calls, run: code => vm.runInContext(code, context), engine: () => calls.engines.at(-1),
    runtime: () => structuredClone(context.forceLayouts.get(context.contextKey())?.positions) };
}

test('首个持续拖动逐帧牵引整图，收敛只提交一次，撤销恢复干净草稿与原运行态', () => {
  const { context, calls, run, runtime, engine } = harness();
  const originalDraft = structuredClone(context.draft);
  run("dragCallbacks.forceDragStart(['a']); dragCallbacks.forceDragMove(['a'], { a: { x: 120, y: 180 } });");
  assert.deepEqual(engine().draggedIds, ['a']);
  engine().tick({ a: { x: 120, y: 180 }, b: { x: 460, y: 260 } });
  engine().tick(arrangedPositions);
  assert.equal(run('dirty()'), false);
  assert.deepEqual(runtime(), arrangedPositions);
  assert.deepEqual(structuredClone(context.draft), originalDraft);
  assert.equal(context.history.length, 0);
  assert.equal(calls.renders, 0, 'tick 不重新投影或重建页面');
  run('dragCallbacks.forceDragEnd()');
  assert.equal(engine().released, true);
  engine().settle();
  assert.equal(context.history.length, 1);
  assert.deepEqual(structuredClone(context.draft.positions), savedPositions);

  run('undo()');
  assert.equal(run('dirty()'), false);
  assert.deepEqual(structuredClone(context.draft), originalDraft);
  assert.deepEqual(runtime(), runtimePositions);
  run('undo(true)');
  assert.equal(run('dirty()'), false);
  assert.deepEqual(runtime(), arrangedPositions);
  assert.deepEqual(structuredClone(context.draft.positions), savedPositions);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.errors.length, 0);
});

test('拖动中撤销先完成当前编辑再恢复原位，迟到的帧与收敛回调不能覆盖结果', () => {
  const { context, calls, run, runtime, engine } = harness();
  run("dragCallbacks.forceDragStart(['a'])");
  const previousEngine = engine(); previousEngine.tick(arrangedPositions);
  run('undo()');
  assert.equal(previousEngine.stopped, true);
  assert.equal(run('dirty()'), false);
  assert.deepEqual(runtime(), runtimePositions);
  assert.equal(context.history.length, 0);
  assert.equal(context.future.length, 1);
  previousEngine.tick(arrangedPositions); previousEngine.settle(arrangedPositions);
  assert.deepEqual(runtime(), runtimePositions);
  assert.equal(context.history.length, 0);
  assert.equal(calls.writes.length, 0);
});

for (const command of ['saveDraft()', 'undo()']) test(`按住节点时执行 ${command} 结束指针手势，后续移动不能脱离模拟修改画面`, async () => {
  const { context, calls, run, engine, runtime } = harness();
  const canvas = context.canvas;
  let released = 0;
  Object.assign(canvas, {
    layoutMode: 'force', callbacks: run('dragCallbacks'),
    root: { hasPointerCapture: () => true, releasePointerCapture: () => { released++; }, classList: { remove() {} } },
    point: event => ({ x: event.clientX, y: event.clientY }), transform() {},
    cancel: GraphCanvas.prototype.cancel,
    gesture: { type: 'nodes', pointerId: 1, ids: ['a'], point: { x: 0, y: 0 }, x: 0, y: 0,
      original: { a: structuredClone(canvas.positions.a) }, moved: false },
  });
  GraphCanvas.prototype.move.call(canvas, { pointerId: 1, clientX: 30, clientY: 0 });
  assert.equal(canvas.gesture.forceDragging, true);
  engine().tick(arrangedPositions);
  await run(command);
  const afterCommand = structuredClone(canvas.positions);
  assert.equal(canvas.gesture, null);
  assert.equal(released, 1);
  assert.equal(context.forceSession, null);
  GraphCanvas.prototype.move.call(canvas, { pointerId: 1, clientX: 90, clientY: 0 });
  assert.deepEqual(structuredClone(canvas.positions), afterCommand);
  assert.deepEqual(runtime(), afterCommand);
  assert.equal(calls.engines.length, 1, '已结束的指针手势不能继续写入或重启模拟');
  assert.equal(run('dirty()'), false);
  assert.equal(calls.writes.length, 0);
  assert.deepEqual(structuredClone(context.draft.positions), savedPositions);
});

test('取消未提交拖动恢复全图位置，既不新增历史也不写文件', () => {
  const { context, calls, run, runtime, engine } = harness();
  const before = structuredClone(context.draft);
  run("dragCallbacks.forceDragStart(['a'])");
  engine().tick(arrangedPositions);
  run('dragCallbacks.forceDragCancel()');
  assert.deepEqual(runtime(), runtimePositions);
  assert.deepEqual(structuredClone(context.canvas.positions), runtimePositions);
  assert.deepEqual(structuredClone(context.draft), before);
  assert.equal(run('dirty()'), false);
  assert.equal(context.history.length, 0);
  assert.equal(calls.writes.length, 0);
});

test('总览 Delete、保存、持续拖动和重排只改变运行态', async () => {
  const { context, calls, run, runtime, engine } = harness({ overview: true });
  context.selection = { type: 'edge', id: 'a-to-b' };
  await run('removeSelection()'); await run('saveDraft()');
  run("dragCallbacks.forceDragStart(['a'])");
  engine().tick(runtimePositions); run('dragCallbacks.forceDragEnd()'); engine().settle();
  const arranged = run('autoLayout()');
  engine().tick(arrangedPositions); engine().settle();
  assert.equal(await arranged, true);
  assert.deepEqual(runtime(), arrangedPositions);
  assert.equal(context.draft, undefined);
  assert.equal(run('dirty()'), false);
  assert.equal(context.history.length, 0);
  assert.deepEqual(calls.writes, []); assert.deepEqual(calls.requests, []); assert.deepEqual(calls.errors, []);
});

test('力导向重排等待自然收敛后释放 arranging，位置只归会话且不保存规则草稿', async () => {
  const { context, calls, run, engine } = harness();
  const arranged = run('autoLayout({ fitView: true })');
  assert.equal(context.arranging, true); assert.equal(calls.writes.length, 0);
  engine().tick(arrangedPositions);
  assert.equal(context.history.length, 0); assert.equal(calls.writes.length, 0);
  engine().settle();
  assert.equal(await arranged, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.arranging, false);
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(calls.requests, []);
  assert.deepEqual(structuredClone(context.draft.positions), savedPositions);
  assert.equal(run('dirty()'), false);
  assert.equal(calls.fits, 1);
});

test('模拟启动失败不改变历史、缓存或磁盘草稿', async () => {
  const { context, calls, run, runtime } = harness();
  const before = structuredClone(context.draft);
  calls.failNextStart = Object.assign(new Error('模拟启动失败'), { code: 'FORCE_LAYOUT_FAILED' });
  await assert.rejects(run('autoLayout()'), { code: 'FORCE_LAYOUT_FAILED' });
  assert.deepEqual(structuredClone(context.draft), before);
  assert.deepEqual(runtime(), runtimePositions);
  assert.equal(context.history.length, 0); assert.equal(context.arranging, false); assert.equal(calls.writes.length, 0);
});

test('模拟途中失败回滚整图并结束等待，失败前的 tick 不提交草稿', async () => {
  const { context, calls, run, runtime, engine } = harness();
  const before = structuredClone(context.draft), arranged = run('autoLayout()');
  engine().tick(arrangedPositions);
  engine().fail(new Error('模拟途中失败'));
  assert.equal(await arranged, false);
  assert.deepEqual(structuredClone(context.draft), before);
  assert.deepEqual(runtime(), runtimePositions);
  assert.equal(context.history.length, 0); assert.equal(context.arranging, false); assert.equal(calls.writes.length, 0);
  assert.match(calls.errors[0].message, /模拟途中失败/);
});

test('总览打开不等待模拟收敛，失败后重新读取可重试且只读取工作区', async () => {
  const { context, calls, run, runtime, engine } = harness({ overview: true });
  context.render = async () => { calls.renders++; return run('ensureForceLayout(graph, projection())') ?? true; };
  assert.equal(run('ensureForceLayout(graph, projection())'), null);
  engine().fail(new Error('模拟器暂时不可用'));
  assert.equal(calls.engines.length, 1);
  assert.equal(await run('openOverview({ guarded: true, reload: true })'), true);
  assert.equal(calls.engines.length, 2); assert.equal(context.opening, false);
  assert.ok(context.forceSession, '首屏已完成时仍允许后台模拟继续');
  engine().tick(arrangedPositions); engine().settle();
  assert.deepEqual(runtime(), arrangedPositions);
  assert.deepEqual(calls.reads, [{ path: '/api/workspace', body: undefined }]);
  assert.deepEqual(calls.writes, []); assert.deepEqual(calls.requests, []);
});

test('新一笔拖动先提交上一笔，再以当前整图作为新撤销基线', () => {
  const { context, run, runtime, engine } = harness();
  run("dragCallbacks.forceDragStart(['a'])"); const first = engine(); first.tick(arrangedPositions);
  run("dragCallbacks.forceDragStart(['b'])");
  assert.equal(first.stopped, true); assert.equal(context.history.length, 1);
  const second = { a: { x: 210, y: 260 }, b: { x: 610, y: 420 } };
  engine().tick(second); engine().settle();
  assert.equal(context.history.length, 2);
  run('undo()'); assert.deepEqual(runtime(), arrangedPositions);
  run('undo()'); assert.deepEqual(runtime(), runtimePositions); assert.equal(run('dirty()'), false);
});

test('模式切换结束旧模拟并恢复连线图位置，迟到回调不污染规则草稿', async () => {
  const { context, calls, run, engine, runtime } = harness();
  vm.runInContext(section('function projection()', 'function render('), context);
  run("dragCallbacks.forceDragStart(['a'])");
  const previous = engine(); previous.tick(arrangedPositions);
  await run("changeGraphMode('orthogonal')");
  assert.equal(previous.stopped, true);
  assert.deepEqual(structuredClone(context.canvas.positions), savedPositions);
  assert.equal(run('dirty()'), false);
  previous.tick(runtimePositions); previous.settle(runtimePositions);
  assert.deepEqual(runtime(), arrangedPositions);
  assert.deepEqual(structuredClone(context.draft.positions), savedPositions);
  await run("changeGraphMode('force')");
  assert.deepEqual(structuredClone(context.canvas.positions), arrangedPositions);
  assert.equal(calls.engines.length, 1);
  assert.equal(calls.requests.length, 0);
});

test('模式是全局持久界面偏好，切换机制或项目和刷新后的新页面继续沿用', async () => {
  const preferences = new Map(), first = harness({ preferences });
  assert.equal(first.run('graphMode()'), 'force');
  await first.run("changeGraphMode('orthogonal')");
  first.context.activeId = 'mechanic-b';
  assert.equal(first.run('graphMode()'), 'orthogonal');
  first.context.workspace.projectRoot = 'G:/另一个项目';
  assert.equal(first.run('graphMode()'), 'orthogonal');
  const refreshed = harness({ preferences });
  assert.equal(refreshed.run('graphMode()'), 'orthogonal');
  assert.equal(refreshed.run('forceMode()'), false);
  const overview = harness({ overview: true, preferences });
  assert.equal(overview.run('forceMode()'), true, '总览继续固定力导向');
  await refreshed.run("changeGraphMode('force')");
  assert.equal(harness({ preferences }).run('graphMode()'), 'force');
  assert.deepEqual(first.calls.requests, [], '界面偏好不写入任何机制文件');
});

test('力导向拖动后的规则保存沿用连线图位置及路线缓存', async () => {
  const { context, calls, run, engine } = harness();
  context.draft.routeCache = { previous: true }; context.baseline.routeCache = { previous: true };
  run("dragCallbacks.forceDragStart(['a'])"); engine().tick(arrangedPositions); engine().settle();
  run("edit(data => { data.name = '新名称'; }, { topology: false })");
  await run('saveDraft()');
  assert.equal(calls.requests.length, 1);
  assert.deepEqual(calls.requests[0].body.document.positions, savedPositions);
  assert.deepEqual(calls.requests[0].body.document.routeCache, { previous: true });
  assert.equal(calls.requests[0].body.document.name, '新名称');
});

test('连线图拖动保存并重开恢复，力导向位置独立保留', async () => {
  const { context, calls, run, runtime } = harness();
  vm.runInContext(section('function projection()', 'function render('), context);
  await run("changeGraphMode('orthogonal')");
  run('positionCallbacks.move({ a: { x: 100, y: 80 } })');
  assert.equal(run('dirty()'), true);
  await run('saveDraft()');
  assert.deepEqual(calls.requests[0].body.document.positions.a, { x: 100, y: 80 });
  context.draft = structuredClone(calls.requests[0].body.document);
  await run("changeGraphMode('force')");
  assert.deepEqual(runtime(), runtimePositions);
  await run("changeGraphMode('orthogonal')");
  assert.deepEqual(structuredClone(context.canvas.positions.a), { x: 100, y: 80 });
});

test('连线图异步重排提交完整几何并保存，切换模式取消旧计算', async () => {
  const { context, calls, run } = harness();
  vm.runInContext(section('function projection()', 'function render('), context);
  await run("changeGraphMode('orthogonal')");
  const routes = [['a-to-b', { points: [{ x: 306, y: 231 }, { x: 520, y: 231 }, { x: 520, y: 351 }] }]];
  context.runGraphCompute = async request => {
    assert.equal(request.kind, 'layout');
    return { positions: structuredClone(arrangedPositions), routes };
  };
  assert.equal(await run('autoLayout()'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.requests[0].body.document.positions, arrangedPositions);
  assert.ok(restoreRouteCache(graph, arrangedPositions, calls.requests[0].body.document.routeCache));
  let finish;
  context.runGraphCompute = request => new Promise((resolve, reject) => { finish = () => {
    if (!request.isCurrent()) { reject(Object.assign(new Error('旧计算已失效'), { code: 'COMPUTE_CANCELLED' })); return; }
    resolve({ positions: arrangedPositions, routes });
  }; });
  context.computeCancelled = error => error.code === 'COMPUTE_CANCELLED';
  const pending = run('autoLayout()');
  await run("changeGraphMode('force')");
  finish();
  assert.equal(await pending, false);
  assert.equal(calls.requests.length, 1);
});
