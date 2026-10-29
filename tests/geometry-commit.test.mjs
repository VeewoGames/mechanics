import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { initialForcePositions } from '../src/web/force-simulation.mjs';

const app = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
const section = (start, end) => {
  const from = app.indexOf(start), to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, '应用函数边界不存在：' + start);
  return app.slice(from, to);
};
const functions = section('function edit(', 'function field(')
  + section('function rememberForcePositions(', 'const compute = new GraphComputeCoordinator');
const graph = { nodes: [{ id: 'a' }, { id: 'scoped-a' }], edges: [{ id: 'rule', source: 'a', target: 'scoped-a' }] };
const originalPositions = { a: { x: 10, y: 20 }, hidden: { x: 900, y: 900 } };
const originalScoped = { 'scoped-a': { x: 310, y: 20 } };
const runtimePositions = { a: { x: 80, y: 120 }, 'scoped-a': { x: 420, y: 160 } };
const finalPositions = { a: { x: 120, y: 80 }, 'scoped-a': { x: 540, y: 240 } };

function harness() {
  const saved = [], errors = [], engines = [];
  const initialDraft = { id: 'mechanic', positions: structuredClone(originalPositions), projectionPositions: structuredClone(originalScoped),
    routeCache: { previous: '旧文件中的派生路线' } };
  const context = vm.createContext({
    graph, draft: structuredClone(initialDraft), baseline: structuredClone(initialDraft),
    history: [], future: [], forceSession: null, forceHistory: new WeakMap(), forceLayouts: new Map([['mechanic', { positions: structuredClone(runtimePositions), topology: 'current' }]]),
    geometryEpoch: 0, arranging: false, selection: null, saveFailure: { blocked: false },
    clone: structuredClone, json: JSON.stringify, initialForcePositions, busy: () => false, definitionMode: () => false, overviewMode: () => false, forceMode: () => true,
    contextKey: () => 'mechanic', displayGraphOf: () => graph, isEndpointProjection: node => node.id === 'scoped-a',
    forceTopologyKey: value => JSON.stringify(value), compute: { cancel() {} },
    createForceSimulation: callbacks => {
      const engine = {
        start(input) { this.positions = structuredClone(input.positions); if (context.startFailure) throw context.startFailure; },
        stop() { this.stopped = true; }, getPositions() { return structuredClone(this.positions); },
        tick(positions) { this.positions = structuredClone(positions); callbacks.onTick({ positions: structuredClone(positions) }); },
        settle() { callbacks.onSettle({ positions: structuredClone(this.positions) }); },
      };
      engines.push(engine); return engine;
    },
    canvas: { positions: structuredClone(runtimePositions), graph, camera: { x: 0, y: 0, scale: 1 }, forceFrameVersion: 1,
      selectedIds: () => [], cancel() {}, fit() {}, updateForcePositions(positions) { this.positions = structuredClone(positions); } },
    render: async () => { context.canvas.positions = context.projection(); return true; }, updateStatus() {}, showError: error => errors.push(error),
    saveDraft: async () => saved.push(structuredClone(context.draft)),
  });
  context.dirty = () => Boolean(context.forceSession?.editRequested || JSON.stringify(context.draft) !== JSON.stringify(context.baseline));
  context.projection = () => structuredClone(context.forceLayouts.get('mechanic')?.positions ?? runtimePositions);
  vm.runInContext(functions, context);
  return { context, initialDraft, saved, errors, run: code => vm.runInContext(code, context), engine: () => engines.at(-1),
    runtime: () => structuredClone(context.forceLayouts.get('mechanic')?.positions) };
}

test('机制模拟收敛分开保存普通与限定端点坐标，撤销重做恢复同一次完整编辑', async () => {
  const { context, initialDraft, saved, run, runtime, engine } = harness();
  const arranged = run('arrangeForceGraph()');
  engine().tick(finalPositions);
  assert.deepEqual(structuredClone(context.draft), initialDraft, '中间帧不触碰草稿或旧路由缓存');
  assert.equal(context.history.length, 0);
  engine().settle(); await arranged;
  assert.deepEqual(structuredClone(context.draft.positions), { ...originalPositions, a: finalPositions.a });
  assert.deepEqual(structuredClone(context.draft.projectionPositions), { 'scoped-a': finalPositions['scoped-a'] });
  assert.equal(context.draft.routeCache, undefined);
  assert.equal(context.history.length, 1); assert.equal(saved.length, 1);
  assert.deepEqual(runtime(), finalPositions);
  run('undo()');
  assert.deepEqual(structuredClone(context.draft), initialDraft);
  assert.deepEqual(runtime(), runtimePositions);
  run('undo(true)');
  assert.deepEqual(structuredClone(context.draft), saved[0]);
  assert.deepEqual(runtime(), finalPositions);
  assert.equal(saved.length, 1, '撤销重做只更新草稿，不隐式保存');
});

test('首次渐进布局立即返回，仅更新运行态，不清理旧缓存、不新增历史或保存', () => {
  const { context, initialDraft, saved, run, runtime, engine } = harness();
  context.forceLayouts.clear();
  assert.equal(run('ensureForceLayout(graph, projection())'), null);
  engine().tick(finalPositions); engine().settle();
  assert.deepEqual(runtime(), finalPositions);
  assert.deepEqual(structuredClone(context.draft), initialDraft);
  assert.equal(context.history.length, 0); assert.equal(saved.length, 0);
});

test('模拟启动失败不提交位置和历史', async () => {
  const { context, initialDraft, saved, run, runtime } = harness();
  context.startFailure = Object.assign(new Error('模拟未启动'), { code: 'FORCE_LAYOUT_FAILED' });
  await assert.rejects(run('arrangeForceGraph()'), { code: 'FORCE_LAYOUT_FAILED' });
  assert.deepEqual(structuredClone(context.draft), initialDraft);
  assert.deepEqual(runtime(), runtimePositions);
  assert.equal(context.history.length, 0); assert.equal(context.arranging, false); assert.equal(saved.length, 0);
});

test('重排中取消可结束等待并回滚，不把未收敛位置写入机制', async () => {
  const { context, initialDraft, saved, run, runtime, engine } = harness();
  const arranged = run('arrangeForceGraph()'); engine().tick(finalPositions);
  run('finishForceSession({ commit: false, rollback: true })');
  assert.equal(await arranged, false);
  assert.equal(engine().stopped, true);
  assert.deepEqual(structuredClone(context.draft), initialDraft);
  assert.deepEqual(runtime(), runtimePositions);
  assert.equal(context.history.length, 0); assert.equal(context.arranging, false); assert.equal(saved.length, 0);
});
