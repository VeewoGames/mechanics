import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { projectDisplayGraph } from '../src/domain/taxonomy-presentation.mjs';
import { GraphCanvas } from '../src/web/canvas.mjs';

const graph = { nodes: ['a', 'b', 'c', 'd', 'e', 'isolated'].map(id => ({ id, label: id })), edges: [
  { id: 'ba', source: 'b', target: 'a', relation: 'influence', sign: 1 },
  { id: 'bc', source: 'b', target: 'c', relation: 'influence', sign: -1 },
  { id: 'cd', source: 'c', target: 'd', relation: 'influence', sign: 'random' },
  { id: 'de', source: 'd', target: 'e', relation: 'influence', sign: 1 },
  { id: 'bb', source: 'b', target: 'b', relation: 'influence', sign: 1 },
] };

const canvasOf = (source = graph) => {
  const canvas = Object.create(GraphCanvas.prototype);
  Object.assign(canvas, { graph: source, selection: { type: 'node', id: 'a' }, layoutMode: 'force' });
  canvas.ensureForceIndex(); return canvas;
};

test('层数按当前选择扩展高亮，完整显示投影和原始关系不变', () => {
  const before = structuredClone(graph);
  const canvas = canvasOf();
  for (const [depth, ids] of [[1, ['a', 'b']], [2, ['a', 'b', 'c']], [3, ['a', 'b', 'c', 'd']], [null, ['a', 'b', 'c', 'd', 'e']]]) {
    canvas.setHighlightDepth(depth);
    assert.deepEqual([...canvas.forceFocusState().relatedNodes], ids);
    assert.deepEqual([...canvas.forceFocusState().relatedEdges], graph.edges.filter(edge => ids.includes(edge.source) && ids.includes(edge.target)).map(edge => edge.id));
    assert.equal(canvas.graph, graph);
    assert.deepEqual(projectDisplayGraph(graph).nodes.map(node => node.id), before.nodes.map(node => node.id));
    assert.deepEqual(projectDisplayGraph(graph).edges, before.edges);
  }
  assert.deepEqual(graph, before);
  canvas.selection = { type: 'node', id: 'isolated' };
  assert.deepEqual([...canvas.forceFocusState().relatedNodes], ['isolated']);
});

test('高亮只遍历结构展示投影中的连线，非法层数明确报错', () => {
  const structural = { nodes: ['child', 'parent', 'neighbor'].map(id => ({ id })), edges: [
    { id: 'parent-edge', source: 'child', target: 'parent', relation: 'specializes' },
    { id: 'influence', source: 'child', target: 'neighbor', relation: 'influence', sign: 1 },
  ] };
  const options = { taxonomyPresentation: { expandedNodeIds: [] }, retainedNodeIds: ['child'] };
  assert.deepEqual(projectDisplayGraph(structural, options).nodes.map(node => node.id), ['child', 'neighbor']);
  options.taxonomyPresentation.expandedNodeIds = ['child'];
  assert.deepEqual(projectDisplayGraph(structural, options).nodes.map(node => node.id), ['child', 'parent', 'neighbor']);
  const canvas = canvasOf(projectDisplayGraph(structural, options)); canvas.selection = { type: 'node', id: 'child' };
  assert.deepEqual([...canvas.forceFocusState().relatedNodes], ['child', 'parent', 'neighbor']);
  for (const depth of [0, 4, '1', undefined]) assert.throws(() => canvas.setHighlightDepth(depth), /层数/);
});

test('更换选择立即切换高亮起点，多选取并集，选中关系仅突出该关系及两端', () => {
  const canvas = canvasOf(); canvas.setHighlightDepth(1);
  canvas.selection = { type: 'node', id: 'd' };
  assert.deepEqual([...canvas.forceFocusState().relatedNodes], ['d', 'c', 'e']);
  canvas.selection = { type: 'nodes', ids: ['a', 'd'] };
  assert.deepEqual([...canvas.forceFocusState().relatedNodes], ['a', 'd', 'b', 'c', 'e']);
  canvas.selection = { type: 'edge', id: 'bc' };
  assert.deepEqual([...canvas.forceFocusState().relatedEdges], ['bc']);
  assert.deepEqual([...canvas.forceFocusState().relatedNodes], ['b', 'c']);
  canvas.selection = null; assert.equal(canvas.forceFocusState().attention, false);
});

const app = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
function highlightHarness(storage = new Map()) {
  const controls = new Map(), depths = [];
  const context = vm.createContext({ graph, selection: { type: 'node', id: 'a' }, geometryEpoch: 0, key: 'project/overview',
    contextKey: () => context.key, projectDisplayGraph, currentTaxonomyPresentation: () => null,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    overviewMode: () => false, draft: null, forceMode: () => true, busy: () => false,
    $: id => { if (!controls.has(id)) controls.set(id, { setAttribute(name, value) { if (name === 'aria-pressed') this.pressed = value; } }); return controls.get(id); },
    finishForceSession() { throw new Error('高亮不能结束模拟'); },
    canvas: { setHighlightDepth: depth => depths.push(depth), fit() { throw new Error('高亮不能改变相机'); } },
    render: async () => { throw new Error('高亮不能重建显示图'); },
  });
  vm.runInContext(app.slice(app.indexOf('const saveUiPreference ='), app.indexOf('const persistTabState =')), context);
  vm.runInContext(app.slice(app.indexOf('let preferredHighlightDepth ='), app.indexOf('let hoverTooltipsEnabled =')), context);
  vm.runInContext(app.slice(app.indexOf('const displayOptions ='), app.indexOf('// 隐藏的节点或连线不能继续被选中')), context);
  return { context, controls, depths, run: code => vm.runInContext(code, context) };
}

test('层数按钮只更新画布注意力，不重建显示图、结束模拟或改变相机，全局沿用', async () => {
  const storage = new Map(), { context, controls, depths } = highlightHarness(storage);
  vm.runInContext('updateGraphFocusControls()', context);
  assert.equal(controls.get('graph-depth-1').disabled, false);
  assert.equal(vm.runInContext('graphHighlightDepth()', context), 1);
  context.selection = { type: 'node', id: 'b' };
  await vm.runInContext('changeGraphDepth(3)', context);
  assert.deepEqual(depths, [3]); assert.equal(storage.get('mechanics:graph-highlight-depth'), '3');
  assert.equal(vm.runInContext('displayGraphOf().nodes.length', context), 6);
  assert.equal(context.geometryEpoch, 0);
  context.key = 'project/mechanic/other';
  assert.equal(vm.runInContext('displayGraphOf().nodes.length', context), 6);
  assert.equal(vm.runInContext('graphHighlightDepth()', context), 3);
  context.key = 'other-project/overview';
  assert.equal(vm.runInContext('graphHighlightDepth()', context), 3);
  await vm.runInContext('changeGraphDepth(null)', context);
  assert.equal(vm.runInContext('displayGraphOf().nodes.length', context), 6);
  assert.equal(vm.runInContext('graphHighlightDepth()', context), null);
  assert.equal(storage.get('mechanics:graph-highlight-depth'), 'all');
  context.selection = null; vm.runInContext('updateGraphFocusControls()', context);
  assert.equal(controls.get('graph-depth-1').disabled, true);
});

test('四种高亮选项在页面重建后恢复，按钮状态与全局偏好一致', async () => {
  const storage = new Map();
  for (const depth of [3, null, 2, 1]) {
    const first = highlightHarness(storage);
    await first.run(`changeGraphDepth(${depth})`);
    const restored = highlightHarness(storage);
    assert.equal(restored.run('graphHighlightDepth()'), depth);
    restored.run('updateGraphFocusControls()');
    for (const option of [1, 2, 3, null]) {
      const control = restored.controls.get('graph-depth-' + (option ?? 'all'));
      assert.equal(control.pressed, String(option === depth));
    }
  }
});

test('高亮偏好缺失、损坏或存储不可用时默认一层，禁用状态不改偏好', async () => {
  for (const value of [undefined, '', '0', '4', 'null', 'true']) {
    const storage = new Map(value === undefined ? [] : [['mechanics:graph-highlight-depth', value]]);
    const { context, run } = highlightHarness(storage);
    assert.equal(run('graphHighlightDepth()'), 1);
    context.selection = null; await run('changeGraphDepth(3)');
    assert.equal(storage.get('mechanics:graph-highlight-depth'), value);
  }
  const storage = { get() { throw new Error('存储不可用'); }, set() { throw new Error('存储不可用'); } };
  const { run } = highlightHarness(storage);
  assert.equal(run('graphHighlightDepth()'), 1);
  await run('changeGraphDepth(2)');
  assert.equal(run('graphHighlightDepth()'), 2, '存储不可用仍可在当前页面切换');
  await assert.rejects(run('changeGraphDepth(4)'), /层数/);
});
