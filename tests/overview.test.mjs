import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeOverview, createOverviewState, forceTopologyKey, overviewRetainedNodeIds, reconcileOverviewState, selectOverviewMechanics } from '../src/web/overview.mjs';
import { endpointProjectionId, projectEndpointQualifiers } from '../src/domain/endpoint-projection.mjs';
import { projectDisplayGraph } from '../src/domain/taxonomy-presentation.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

const node = id => ({ id, label: id, description: id, increaseMeaning: id });
const mechanic = (id, focusNodeIds, pinnedRuleIds = []) => ({
  id, name: id, ruleSelection: 'explicit', focusNodeIds, pinnedRuleIds, positions: {},
});
function fixture() {
  return {
    manifest: { id: 'overview-test' }, revision: 'one',
    definitions: { nodes: ['attack', 'health', 'burn', 'outside', 'unused'].map(node) },
    rules: { rules: [
      { id: 'damage', source: 'attack', target: 'health', relation: 'influence', sign: -1 },
      { id: 'burn-damage', source: 'burn', target: 'health', relation: 'influence', sign: -1 },
      { id: 'health-effect', source: 'health', target: 'outside', relation: 'influence', sign: 1 },
    ] },
    mechanics: [mechanic('combat', ['attack', 'health'], ['damage']),
      mechanic('burning', ['burn', 'health'], ['burn-damage']), mechanic('shared', ['health'], ['damage'])],
    views: [], files: [],
  };
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('总览默认选择全部机制，重叠范围中的节点和规则只呈现一次', () => {
  const workspace = freeze(fixture()), before = structuredClone(workspace);
  const state = freeze(createOverviewState(workspace));
  assert.deepEqual(state.selectedIds, ['combat', 'burning', 'shared']);
  assert.notEqual(state.knownIds, state.selectedIds);
  const selected = selectOverviewMechanics(state, ['shared', 'combat', 'shared']);
  assert.deepEqual(selected.selectedIds, ['combat', 'shared']);
  const graph = composeOverview(workspace, selected);
  assert.deepEqual(graph.graphIds, ['combat', 'shared']);
  assert.deepEqual(graph.nodes.map(item => item.id), ['attack', 'health']);
  assert.deepEqual(graph.edges.map(item => item.id), ['damage']);
  assert.deepEqual(graph.nodes.find(item => item.id === 'health').sourceGraphIds, ['combat', 'shared']);
  graph.nodes[0].label = '只改投影';
  graph.edges[0].steps[0].sign = 1;
  assert.deepEqual(workspace, before);
  assert.deepEqual(state.selectedIds, ['combat', 'burning', 'shared']);
});

test('空筛选得到空图，未知机制明确失败且不改变当前筛选', () => {
  const workspace = freeze(fixture()), state = freeze(createOverviewState(workspace));
  assert.deepEqual(composeOverview(workspace, selectOverviewMechanics(state, [])), { graphIds: [], nodes: [], edges: [] });
  assert.throws(() => selectOverviewMechanics(state, ['missing']), /不存在的机制/);
  assert.throws(() => composeOverview(workspace, { ...state, selectedIds: ['missing'] }), /选中的机制图不存在：missing/);
  assert.deepEqual(state.selectedIds, ['combat', 'burning', 'shared']);
  const empty = { ...workspace, mechanics: [] };
  assert.deepEqual(composeOverview(empty, createOverviewState(empty)), { graphIds: [], nodes: [], edges: [] });
});

test('总览保留机制原有的显式规则范围与相邻规则扩展语义', () => {
  const workspace = fixture();
  workspace.mechanics.push({ ...mechanic('adjacent', ['health']), ruleSelection: undefined });
  const state = createOverviewState(workspace);
  assert.deepEqual(composeOverview(workspace, selectOverviewMechanics(state, ['shared'])).edges.map(item => item.id), ['damage']);
  const graph = composeOverview(workspace, selectOverviewMechanics(state, ['adjacent', 'shared']));
  assert.deepEqual(graph.edges.map(item => item.id), ['burn-damage', 'damage', 'health-effect']);
  assert.equal(graph.nodes.some(item => item.id === 'unused'), false);
});

test('总览最终投影保留孤立焦点与仅结构关系的焦点，不复活隐式父概念', () => {
  const workspace = freeze({
    definitions: { nodes: ['isolated', 'child', 'implicit-parent', 'explicit-parent', 'unselected'].map(node) },
    rules: { rules: [{ id: 'classification', source: 'child', target: 'implicit-parent', relation: 'specializes' }] },
    mechanics: [mechanic('main', ['isolated', 'child', 'explicit-parent'], ['classification']),
      mechanic('shared', ['child']), mechanic('hidden', ['unselected', 'implicit-parent'])],
  });
  const state = freeze(selectOverviewMechanics(createOverviewState(workspace), ['main', 'shared']));
  const retainedNodeIds = overviewRetainedNodeIds(workspace, state);
  assert.deepEqual(retainedNodeIds, ['isolated', 'child', 'explicit-parent']);
  const endpoints = projectEndpointQualifiers(composeOverview(workspace, state));
  const display = projectDisplayGraph(endpoints, { taxonomyPresentation: state.taxonomyPresentation, retainedNodeIds });
  assert.deepEqual(display.nodes.map(item => item.id), ['isolated', 'child', 'explicit-parent']);
  assert.deepEqual(display.edges, []);
  assert.equal(display.nodes.find(item => item.id === 'child').badges[0].targetId, 'implicit-parent');
  const expanded = projectDisplayGraph(endpoints, { taxonomyPresentation: { mode: 'label', expandedNodeIds: ['child'] }, retainedNodeIds });
  assert.deepEqual(expanded.nodes.map(item => item.id), ['isolated', 'child', 'implicit-parent', 'explicit-parent']);
  assert.deepEqual(expanded.edges.map(item => item.id), ['classification']);
  assert.deepEqual(overviewRetainedNodeIds(workspace, selectOverviewMechanics(state, [])), []);
  assert.throws(() => overviewRetainedNodeIds(workspace, { ...state, selectedIds: ['missing'] }), /选中的机制图不存在：missing/);
});

test('总览保留焦点不会把端点限定投影已替代的基础实例重新画出', () => {
  const qualifiers = [{ key: '阵营', value: { kind: 'literal', value: '敌方' } }];
  const workspace = freeze({
    definitions: { nodes: ['source', 'target', 'isolated'].map(node) },
    rules: { rules: [{ id: 'effect', source: 'source', target: 'target', relation: 'influence', sign: -1, sourceQualifiers: qualifiers }] },
    mechanics: [mechanic('main', ['source', 'target', 'isolated'], ['effect'])],
  });
  const state = freeze(createOverviewState(workspace));
  const display = projectDisplayGraph(projectEndpointQualifiers(composeOverview(workspace, state)), {
    taxonomyPresentation: state.taxonomyPresentation, retainedNodeIds: overviewRetainedNodeIds(workspace, state),
  });
  const scopedSource = endpointProjectionId('source', qualifiers);
  assert.deepEqual(display.nodes.map(item => item.id), ['target', 'isolated', scopedSource]);
  assert.equal(display.edges[0].source, scopedSource);
  assert.equal(display.edges[0].target, 'target');
});

test('刷新加入新机制、移除已删除机制，保留隐藏选择与会话位置', () => {
  const workspace = freeze(fixture());
  const state = freeze({ ...selectOverviewMechanics(createOverviewState(workspace), ['combat', 'shared']),
    positions: { health: { x: 20, y: 40 } }, projectionPositions: { 'projected-health': { x: 60, y: 80 } },
    taxonomyPresentation: { mode: 'expanded', expandedNodeIds: ['health'] } });
  const refreshedWorkspace = freeze({ ...workspace, mechanics: [workspace.mechanics[1], workspace.mechanics[0], mechanic('new', ['outside'])] });
  const refreshed = reconcileOverviewState(state, refreshedWorkspace);
  assert.deepEqual(refreshed.knownIds, ['burning', 'combat', 'new']);
  assert.deepEqual(refreshed.selectedIds, ['combat', 'new']);
  assert.deepEqual(refreshed.positions, state.positions);
  assert.deepEqual(refreshed.projectionPositions, state.projectionPositions);
  assert.deepEqual(refreshed.taxonomyPresentation, state.taxonomyPresentation);
  assert.deepEqual(reconcileOverviewState(refreshed, refreshedWorkspace), refreshed);
  assert.deepEqual(state.selectedIds, ['combat', 'shared']);
  const hidden = selectOverviewMechanics(refreshed, []);
  const withAnother = { ...refreshedWorkspace, mechanics: [...refreshedWorkspace.mechanics, mechanic('another', ['unused'])] };
  assert.deepEqual(reconcileOverviewState(hidden, withAnother).selectedIds, ['another']);
});

// 对真实工作区做文件快照，约束会话操作不得隐式创建视图或保存项目文档。
async function snapshotFiles(root, relative = '') {
  const entries = await readdir(join(root, relative), { withFileTypes: true }), result = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshotFiles(root, path));
    else result[path] = (await readFile(join(root, path))).toString('base64');
  }
  return result;
}

test('创建、筛选和刷新总览不修改工作区对象，也不创建或写入文件', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'mechanics-overview-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await copyExampleFixture(projectRoot);
  const root = join(projectRoot, '.mechanics'), filesBefore = await snapshotFiles(root);
  const workspace = freeze(await readWorkspace(root)), before = structuredClone(workspace);
  let state = createOverviewState(workspace);
  composeOverview(workspace, state);
  state = selectOverviewMechanics(state, state.knownIds.slice(0, 1));
  composeOverview(workspace, state);
  state = { ...state, positions: { temporary: { x: 120, y: 80 } } };
  state = reconcileOverviewState(state, workspace);
  composeOverview(workspace, selectOverviewMechanics(state, []));
  assert.deepEqual(workspace, before);
  assert.deepEqual(await snapshotFiles(root), filesBefore);
});

test('力导向拓扑标识忽略列表顺序和显示文案，识别节点与端点变化', () => {
  const workspace = fixture(), graph = composeOverview(workspace, createOverviewState(workspace));
  const key = forceTopologyKey(graph);
  const reordered = { nodes: [...graph.nodes].reverse().map(item => ({ ...item, label: '重命名' })), edges: [...graph.edges].reverse() };
  assert.equal(forceTopologyKey(reordered), key);
  assert.notEqual(forceTopologyKey({ ...graph, nodes: [...graph.nodes, node('new')] }), key);
  assert.notEqual(forceTopologyKey({ ...graph, edges: graph.edges.map((edge, index) => index ? edge : { ...edge, target: 'attack' }) }), key);
});
