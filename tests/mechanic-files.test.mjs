import test from 'node:test';
import assert from 'node:assert/strict';
import { graphPositions, readOpening } from '../src/web/mechanic-files.mjs';

function fixture() {
  return {
    manifest: { lastView: { viewId: 'missing-view' } },
    definitions: { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], positions: { b: { x: 2, y: 3 } } },
    rules: { rules: [] },
    mechanics: [
      { id: 'first', focusNodeIds: ['a'], pinnedRuleIds: [], positions: { a: { x: 10, y: 20 } } },
      { id: 'empty', focusNodeIds: [], pinnedRuleIds: [], positions: {} },
    ],
    files: [{ kind: 'mechanic', id: 'first', path: 'mechanics/first.mechanic.json' }, { kind: 'mechanic', id: 'empty', path: 'mechanics/empty.mechanic.json' }],
    resourceRevisions: { mechanics: { first: 'first-revision', empty: 'old-revision' } },
  };
}

test('机制打开复用快照，不访问旧视图记录或写入接口', async () => {
  const workspace = fixture(), before = structuredClone(workspace);
  Object.defineProperty(workspace.manifest, 'lastView', { get() { throw new Error('不应读取旧视图记录'); } });
  const opened = await readOpening(() => { throw new Error('缓存命中时不应请求接口'); }, { kind: 'mechanic', id: 'first' }, workspace);
  assert.equal(opened.workspace, workspace);
  assert.equal(opened.activeId, 'first');
  assert.deepEqual(opened.graph.graphIds, ['first']);
  assert.deepEqual(opened.graph.nodes.map(node => node.id), ['a']);
  assert.deepEqual(workspace.mechanics, before.mechanics);
  assert.equal('viewId' in opened, false);
});

test('网页加载模块只接受显式机制请求，不把同名旧视图当作机制', async () => {
  const workspace = fixture();
  for (const request of [undefined, 'first', { kind: 'view', id: 'first' }]) {
    await assert.rejects(readOpening(() => {}, request, workspace), /mechanic 类型/);
  }
  await assert.rejects(readOpening(() => {}, { kind: 'mechanic', id: 'missing' }, workspace), /机制文件不存在/);
});

test('未命中缓存时只读取工作区，空机制按目标文件单独刷新且不修改旧快照', async () => {
  const workspace = fixture(), requests = [];
  const opened = await readOpening(async (path, body) => { requests.push({ path, body }); return workspace; }, { kind: 'mechanic', id: 'first' });
  assert.equal(opened.workspace, workspace);
  assert.deepEqual(requests, [{ path: '/api/workspace', body: undefined }]);
  const before = structuredClone(workspace);
  const updated = await readOpening(() => { throw new Error('不应全量读取'); }, { kind: 'mechanic', id: 'empty' }, workspace, async request => {
    assert.deepEqual(request, { id: 'empty', file: 'mechanics/empty.mechanic.json' });
    return { mechanic: { ...workspace.mechanics[1], focusNodeIds: ['b'] }, resourceRevision: 'new-revision' };
  });
  assert.deepEqual(updated.graph.nodes.map(node => node.id), ['b']);
  assert.equal(updated.workspace.resourceRevisions.mechanics.empty, 'new-revision');
  assert.deepEqual(workspace, before);
});

test('目标机制刷新失败或引用损坏时拒绝打开，保留原快照', async () => {
  const workspace = fixture(), before = structuredClone(workspace);
  await assert.rejects(readOpening(() => {}, { kind: 'mechanic', id: 'empty' }, workspace, async () => { throw new Error('文件读取失败'); }), /文件读取失败/);
  await assert.rejects(readOpening(() => {}, { kind: 'mechanic', id: 'empty' }, workspace, async () => ({
    mechanic: { ...workspace.mechanics[1], id: 'other' }, resourceRevision: 'changed',
  })), /机制文件不存在/);
  assert.deepEqual(workspace, before);
});

test('坐标优先级保留机制位置，其次页面记忆、共享位置和临时补位，结果独立克隆', () => {
  const workspace = fixture(), graph = { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const remembered = { a: { x: 100, y: 100 }, b: { x: 200, y: 200 } }, implicit = { c: { x: 300, y: 300 } };
  const positions = graphPositions(workspace, graph, remembered, 'first', implicit);
  assert.deepEqual(positions, { a: { x: 10, y: 20 }, b: { x: 200, y: 200 }, c: { x: 300, y: 300 } });
  positions.a.x = 999; positions.b.x = 999; positions.c.x = 999;
  assert.equal(workspace.mechanics[0].positions.a.x, 10);
  assert.equal(remembered.b.x, 200); assert.equal(implicit.c.x, 300);
  assert.deepEqual(graphPositions(workspace, graph).b, { x: 2, y: 3 });
});
