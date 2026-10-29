import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ELK from 'elkjs/lib/elk.bundled.js';
import { autoLayoutGraph } from '../src/web/auto-layout.mjs';
import { computeGraphTask } from '../src/web/graph-compute-kernel.mjs';
import { restoreRouteCache } from '../src/web/route-cache.mjs';
import { projectDisplayGraph } from '../src/domain/taxonomy-presentation.mjs';

const graph = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ id: 'a-b', source: 'a', target: 'b' }] };
const positions = { a: { x: 0, y: 0 }, b: { x: 320, y: 0 } };

test('共享正交布局 Worker 返回可持久化的完整 route cache', async () => {
  const direct = await autoLayoutGraph({ graph, positions, selectedIds: [], cachedRoutes: [], ELK });
  const worker = await computeGraphTask({ kind: 'layout', payload: { graph, positions, selectedIds: [], cachedRoutes: [] } }, { ELK });
  assert.deepEqual(worker.positions, direct.positions);
  assert.deepEqual(worker.routes, [...direct.routes]);
  assert.deepEqual(worker.routeCache, direct.routeCache);
  assert.deepEqual(restoreRouteCache(graph, worker.positions, worker.routeCache), new Map(worker.routes));
});

const app = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
const autoLayout = app.slice(app.indexOf('function rememberForcePositions('), app.indexOf('const compute = new GraphComputeCoordinator'))
  + app.slice(app.indexOf('async function autoLayout('), app.indexOf('async function applyBrowsingWorkspace('));

test('自动排版与路由缓存只消费显示投影：隐藏的 is-a 父概念不参与布局或路线', async () => {
  const taxonomy = {
    nodes: [
      { id: 'child', label: '子概念' },
      { id: 'parent', label: '父概念' },
      { id: 'effect', label: '效果' },
    ],
    edges: [
      { id: 'child-is-parent', source: 'child', target: 'parent', relation: 'specializes' },
      { id: 'child-affects-effect', source: 'child', target: 'effect', relation: 'influence', sign: 1 },
    ],
  };
  const taxonomyPositions = { child: { x: 0, y: 0 }, parent: { x: 320, y: 0 }, effect: { x: 640, y: 0 } };
  const displayed = projectDisplayGraph(taxonomy, { taxonomyPresentation: { mode: 'label', expandedNodeIds: [] }, retainedNodeIds: ['child'] });
  assert.deepEqual(displayed.nodes.map(node => node.id), ['child', 'effect']);
  const layout = await autoLayoutGraph({ graph: displayed, positions: taxonomyPositions, selectedIds: [], cachedRoutes: [], ELK });
  assert.deepEqual(Object.keys(layout.positions).sort(), ['child', 'effect']);
  assert.deepEqual(Object.keys(layout.routeCache.paths).sort(), ['child-affects-effect']);
  // 完整图的缓存带着 is-a 边，显示投影必须拒绝它，不能让隐藏父概念的路线复活。
  const fullCache = await autoLayoutGraph({ graph: taxonomy, positions: taxonomyPositions, selectedIds: [], cachedRoutes: [], ELK });
  assert.equal(restoreRouteCache(displayed, layout.positions, fullCache.routeCache), null);
  assert.deepEqual(restoreRouteCache(displayed, layout.positions, layout.routeCache), new Map(layout.routes));
  // 展开后父概念回到同一投影，布局才重新包含它。
  const expanded = projectDisplayGraph(taxonomy, { taxonomyPresentation: { mode: 'label', expandedNodeIds: ['child'] }, retainedNodeIds: ['child'] });
  assert.deepEqual(expanded.nodes.map(node => node.id), ['child', 'parent', 'effect']);
});

function harness() {
  const calls = { commits: [], saves: [], fits: 0, engines: [], errors: [] };
  const context = vm.createContext({
    graph, arranging: false, forceSession: null, forceLayouts: new Map(), saveFailure: { blocked: false },
    busy: () => false, definitionMode: () => false, overviewMode: () => false, forceMode: () => true, dirty: () => true, contextKey: () => 'mechanic/a',
    projection: () => positions, displayGraphOf: () => graph, forceTopologyKey: value => JSON.stringify(value),
    clone: structuredClone, json: JSON.stringify, isEndpointProjection: () => false,
    createForceSimulation: callbacks => {
      const engine = {
        start(input) { this.input = structuredClone(input); this.positions = structuredClone(input.positions); if (context.startFailure) throw context.startFailure; },
        stop() {}, getPositions() { return structuredClone(this.positions); },
        tick(next) { this.positions = structuredClone(next); callbacks.onTick({ positions: structuredClone(next) }); },
        settle() { callbacks.onSettle({ positions: structuredClone(this.positions) }); },
      };
      calls.engines.push(engine); return engine;
    },
    edit: (change, options) => {
      const draft = { positions: structuredClone(positions) }; change(draft);
      calls.commits.push({ draft, options: structuredClone(options) });
    },
    canvas: { positions: structuredClone(positions), camera: { x: 0, y: 0, scale: 1 }, forceFrameVersion: 1,
      selectedIds: () => ['b'], fit() { calls.fits++; }, updateForcePositions() {} },
    updateStatus() {}, showError: error => calls.errors.push(error),
    saveDraft: async options => calls.saves.push({ options: structuredClone(options), arranging: context.arranging }),
  });
  vm.runInContext(autoLayout, context);
  return { context, calls, run: code => vm.runInContext(code, context), engine: () => calls.engines.at(-1) };
}

test('自动布局模拟启动失败时不提交几何，也不触发草稿自动保存', async () => {
  const { context, calls, run } = harness();
  context.startFailure = Object.assign(new Error('读取图 自动布局输入 的边 a-b 缺少目标节点：absent'), { code: 'READ_GRAPH_MISSING_ENDPOINT' });
  await assert.rejects(run('autoLayout({ fitView: true })'), { code: 'READ_GRAPH_MISSING_ENDPOINT' });
  assert.deepEqual(calls.commits, []); assert.deepEqual(calls.saves, []);
  assert.equal(context.arranging, false);
});

test('机制自动整理只把选中范围交给持续模拟，收敛后释放 arranging 再非阻塞保存', async () => {
  const { context, calls, run, engine } = harness();
  const arranged = run('autoLayout({ fitView: true })');
  assert.equal(context.arranging, true);
  assert.deepEqual(engine().input.graph, graph);
  assert.deepEqual(engine().input.selectedIds, ['b']);
  assert.deepEqual(calls.commits, []); assert.deepEqual(calls.saves, []);
  const next = { a: positions.a, b: { x: 500, y: 100 } };
  engine().tick(next);
  assert.deepEqual(calls.commits, []); assert.deepEqual(calls.saves, []);
  engine().settle();
  assert.equal(await arranged, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.commits.length, 1);
  assert.deepEqual(calls.commits[0].draft.positions, next);
  assert.equal(context.arranging, false);
  assert.equal(calls.fits, 1);
  assert.deepEqual(calls.saves, [{ options: { blocking: false }, arranging: false }]);
});
