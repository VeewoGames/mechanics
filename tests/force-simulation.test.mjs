import test from 'node:test';
import assert from 'node:assert/strict';
import { createForceSimulation, initialForcePositions } from '../src/web/force-simulation.mjs';
import { FORCE_NODE_MIN_RADIUS } from '../src/web/force-geometry.mjs';

const graphOf = (ids, pairs = []) => ({ nodes: ids.map(id => ({ id, label: id })),
  edges: pairs.map(([source, target], index) => ({ id: `rule-${index}`, source, target, relation: 'influence', sign: 1 })) });
// 圆形节点：圆心距离至少为两个最小半径加碰撞留白，任何两个圆都不重叠，名字也有落脚处。
const separated = positions => {
  const values = Object.values(positions);
  for (const point of values) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
    assert.ok(Math.hypot(values[i].x - values[j].x, values[i].y - values[j].y) >= FORCE_NODE_MIN_RADIUS * 2 + 29.99, `节点 ${i}/${j} 圆形重叠`);
  }
};
function harness(options = {}) {
  let time = 0, nextId = 0; const queue = new Map(), ticks = [], settles = [], errors = [];
  const simulation = createForceSimulation({ requestFrame: callback => { queue.set(++nextId, callback); return nextId; },
    cancelFrame: id => queue.delete(id), now: () => time, onTick: value => ticks.push(value),
    onSettle: value => settles.push(value), onError: error => errors.push(error), ...options });
  const frame = (milliseconds = 16) => {
    time += milliseconds;
    const pending = [...queue.values()]; queue.clear();
    for (const callback of pending) callback();
    assert.equal(errors.length, 0, errors[0]?.message);
    return pending.length;
  };
  const run = (limit = 200) => { for (let i = 0; queue.size && i < limit; i++) frame(); };
  return { simulation, queue, ticks, settles, errors, frame, run };
}

test('启动只安排下一帧，已有坐标热启动且领域输入不变', () => {
  const graph = graphOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
  const positions = { a: { x: 0, y: 0 }, b: { x: 350, y: 20 }, c: { x: 700, y: 0 } };
  const before = structuredClone({ graph, positions }), h = harness();
  assert.equal(h.simulation.start({ graph, positions }), h.simulation);
  assert.equal(h.ticks.length, 0); assert.equal(h.settles.length, 0); assert.equal(h.queue.size, 1);
  assert.deepEqual(h.simulation.getPositions(), positions);
  h.run();
  assert.equal(h.settles.length, 1); assert.equal(h.simulation.getStats().running, false);
  assert.deepEqual({ graph, positions }, before); separated(h.settles[0].positions);
});

test('拖住卡片精确固定，连接节点实时牵引，松手后继续收敛', () => {
  const graph = graphOf(['held', 'linked', 'distant'], [['held', 'linked']]);
  const h = harness(), positions = { held: { x: 0, y: 0 }, linked: { x: 250, y: 0 }, distant: { x: 2000, y: 1200 } };
  h.simulation.start({ graph, positions }).dragStart(['held']).drag(['held'], { held: { x: -600, y: 0 } });
  const before = h.simulation.getPositions();
  for (let i = 0; i < 25; i++) { h.frame(); assert.deepEqual(h.simulation.getPositions().held, { x: -600, y: 0 }); }
  assert.ok(h.simulation.getPositions().linked.x < before.linked.x - 40, '弹簧须在拖动期间牵引相邻节点');
  assert.equal(h.settles.length, 0);
  h.simulation.dragEnd(); h.frame();
  assert.notDeepEqual(h.simulation.getPositions().held, { x: -600, y: 0 }, '释放节点须参与后续收敛');
  h.run(); assert.equal(h.settles.length, 1); separated(h.simulation.getPositions());
});

test('多卡片拖动保持鼠标偏移并推动碰撞节点，局部重排固定范围外卡片', () => {
  const h = harness(), graph = graphOf(['a', 'b', 'neighbor', 'outside'], [['a', 'neighbor']]);
  const positions = { a: { x: 0, y: 0 }, b: { x: 0, y: 200 }, neighbor: { x: 400, y: 0 }, outside: { x: 1600, y: 0 } };
  h.simulation.start({ graph, positions, selectedIds: ['a', 'b', 'neighbor'] });
  h.simulation.dragStart(['a', 'b']).drag(['a', 'b'], { a: { x: 400, y: 0 }, b: { x: 400, y: 200 } });
  for (let i = 0; i < 8; i++) h.frame();
  const during = h.simulation.getPositions();
  assert.deepEqual(during.a, { x: 400, y: 0 }); assert.deepEqual(during.b, { x: 400, y: 200 });
  assert.deepEqual(during.outside, positions.outside); separated(during);
  h.simulation.dragEnd(); h.run(); assert.deepEqual(h.simulation.getPositions().outside, positions.outside);
});

test('环、双向、自环和孤立重合节点有限且分离，显式固定位置不漂移', () => {
  const graph = graphOf(['a', 'b', 'c', 'alone', 'fixed'], [['a', 'b'], ['b', 'a'], ['b', 'c'], ['c', 'a'], ['alone', 'alone']]);
  const positions = Object.fromEntries(graph.nodes.map(node => [node.id, { x: 0, y: 0 }]));
  const h = harness(); h.simulation.start({ graph, positions, fixedNodeIds: ['fixed'] }); h.run();
  assert.equal(h.simulation.getStats().edgeCount, 3); assert.deepEqual(h.simulation.getPositions().fixed, positions.fixed);
  separated(h.simulation.getPositions()); assert.equal(h.settles.length, 1);
});

test('停止、取消与重启隔离旧帧，主动停止不触发保存式完成通知', () => {
  const h = harness(), graph = graphOf(['a', 'b'], [['a', 'b']]);
  h.simulation.start({ graph }); const oldFrame = [...h.queue.values()][0];
  h.simulation.cancel(); oldFrame(); assert.equal(h.ticks.length, 0); assert.equal(h.settles.length, 0);
  h.simulation.start({ graph }); h.frame(); h.simulation.stop();
  assert.equal(h.queue.size, 0); assert.equal(h.settles.length, 0);
  h.simulation.start({ graph: graphOf(['new']) }); oldFrame(); h.run();
  assert.deepEqual(Object.keys(h.settles[0].positions), ['new']);
});

test('无效引用和坐标明确报错，失败输入不破坏当前模拟', () => {
  const h = harness(), graph = graphOf(['a', 'b'], [['a', 'b']]); h.simulation.start({ graph });
  const before = h.simulation.getPositions();
  assert.throws(() => h.simulation.start({ graph: graphOf(['a'], [['a', 'missing']]) }), { code: 'READ_GRAPH_MISSING_ENDPOINT' });
  assert.throws(() => h.simulation.start({ graph, positions: { a: { x: Infinity, y: 0 } } }), { code: 'FORCE_SIMULATION_INVALID_POSITION' });
  assert.throws(() => h.simulation.start({ graph, fixedNodeIds: ['a'] }), { code: 'FORCE_SIMULATION_INVALID_POSITION' });
  assert.throws(() => h.simulation.start({ graph, selectedIds: ['missing'] }), { code: 'FORCE_SIMULATION_INVALID_SELECTION' });
  assert.throws(() => h.simulation.drag(['a'], { a: { x: 5, y: 5 } }), { code: 'FORCE_SIMULATION_DRAG_NOT_STARTED' });
  h.simulation.dragStart(['a', 'b']);
  assert.throws(() => h.simulation.drag(['a', 'b'], { a: { x: 5, y: 5 }, b: { x: NaN, y: 0 } }), { code: 'FORCE_SIMULATION_INVALID_POSITION' });
  assert.deepEqual(h.simulation.getPositions(), before); assert.equal(h.queue.size, 1);
});

test('1500 个重合节点和 3000 条边按预算分片，一帧最多一个通知', () => {
  const count = 1500, ids = Array.from({ length: count }, (_, i) => `n${i}`);
  const graph = graphOf(ids, ids.flatMap((id, i) => [[id, ids[(i + 1) % count]], [id, ids[(i + 47) % count]]]));
  let budgetClock = 0;
  const h = harness({ now: () => (budgetClock += .25), frameBudgetMs: 2, maxDurationMs: 10000 });
  h.simulation.start({ graph, positions: Object.fromEntries(ids.map(id => [id, { x: 0, y: 0 }])) });
  assert.equal(h.ticks.length, 0); assert.equal(h.simulation.getStats().edgeCount, 3000);
  assert.equal(new Set(Object.values(h.simulation.getPositions()).map(p => `${p.x}/${p.y}`)).size, count);
  h.frame(); assert.equal(h.simulation.getStats().stepCount, 0, '预算不足必须保留物理步游标至下一帧');
  for (let i = 0; i < 120; i++) { const before = h.ticks.length; h.frame(); assert.ok(h.ticks.length - before <= 1); }
  assert.ok(h.simulation.getStats().stepCount >= 1);
  for (const point of Object.values(h.simulation.getPositions())) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  h.simulation.cancel(); assert.equal(h.queue.size, 0);
});

test('有界收敛不结束正在拖动的节点，释放后重新计时', () => {
  const h = harness({ maxDurationMs: 32 }), graph = graphOf(['a', 'b'], [['a', 'b']]);
  h.simulation.start({ graph }).dragStart(['a']);
  for (let i = 0; i < 10; i++) h.frame();
  assert.equal(h.settles.length, 0);
  h.simulation.dragEnd(); assert.equal(h.simulation.getStats().activeElapsedMs, 0);
  h.frame(); assert.equal(h.settles.length, 0);
  h.frame(); assert.equal(h.settles.length, 1); assert.equal(h.simulation.getStats().reason, 'time-limit');
});

test('首帧或中途 RAF 暂停超过收敛时限，恢复后仍逐帧继续布局', () => {
  const h = harness(), graph = graphOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
  h.simulation.start({ graph });
  h.frame(5000);
  assert.equal(h.simulation.getStats().activeElapsedMs, 16, '等待首帧的后台时间不占收敛预算');
  assert.equal(h.simulation.getStats().stepCount, 1); assert.equal(h.simulation.getStats().running, true);
  assert.equal(h.settles.length, 0);
  h.frame(10000);
  assert.equal(h.simulation.getStats().activeElapsedMs, 56, '恢复帧间隔最多按 40ms 累计');
  assert.equal(h.simulation.getStats().stepCount, 2); assert.equal(h.settles.length, 0);
  h.run();
  assert.ok(h.simulation.getStats().stepCount > 6); assert.equal(h.settles.length, 1);
});

test('首次种子按拓扑聚集，稳定顺序与断开分量不依赖输入数组排列', () => {
  const ids = Array.from({ length: 180 }, (_, i) => `n${String(i).padStart(3, '0')}`);
  const pairs = ids.slice(1).filter((id, i) => (i + 1) % 30).map(id => [ids[Math.floor(ids.indexOf(id) / 30) * 30], id]);
  const graph = graphOf(ids, pairs), before = structuredClone(graph), positions = initialForcePositions(graph);
  separated(positions); assert.deepEqual(graph, before);
  assert.deepEqual(initialForcePositions({ nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() }), positions);
  const grid = Object.fromEntries(ids.map((id, i) => [id, { x: (i % 15) * 235, y: Math.floor(i / 15) * 160 }]));
  const edgeLength = points => graph.edges.reduce((sum, edge) => sum + Math.hypot(points[edge.source].x - points[edge.target].x, points[edge.source].y - points[edge.target].y), 0);
  assert.ok(edgeLength(positions) < edgeLength(grid) * .65, '同一枢纽的卡片应优先聚集，而非继续按 ID 逐行排列');
  assert.deepEqual(initialForcePositions(graphOf([])), {});
  assert.throws(() => initialForcePositions(graphOf(['one'], [['one', 'missing']])), { code: 'READ_GRAPH_MISSING_ENDPOINT' });
});

test('拖动唤醒所在连通分量，远处分量不会因重新升温而炸开', () => {
  const h = harness(), graph = graphOf(['held', 'linked', 'other-a', 'other-b'], [['held', 'linked'], ['other-a', 'other-b']]);
  h.simulation.start({ graph, positions: { held: { x: 0, y: 0 }, linked: { x: 350, y: 0 }, 'other-a': { x: 2000, y: 2000 }, 'other-b': { x: 2400, y: 2200 } } });
  h.run(); const before = h.simulation.getPositions();
  h.simulation.dragStart(['held']).drag(['held'], { held: { x: -400, y: 200 } });
  for (let i = 0; i < 30; i++) h.frame();
  const during = h.simulation.getPositions();
  assert.notDeepEqual(during.linked, before.linked);
  for (const id of ['other-a', 'other-b']) assert.deepEqual(during[id], before[id]);
  h.simulation.dragEnd(); h.run();
  for (const id of ['other-a', 'other-b']) assert.deepEqual(h.simulation.getPositions()[id], before[id]);
});

test('拖动牵引超过两跳的连通节点，松手后按目标温度平滑冷却', () => {
  const h = harness(), ids = ['a', 'b', 'c', 'd', 'e'], graph = graphOf(ids, ids.slice(1).map((id, i) => [ids[i], id]));
  h.simulation.start({ graph, positions: Object.fromEntries(ids.map((id, i) => [id, { x: i * 190, y: 0 }])) });
  h.run(); const before = h.simulation.getPositions();
  h.simulation.dragStart(['a']).drag(['a'], { a: { x: before.a.x - 500, y: before.a.y } });
  for (let i = 0; i < 60; i++) h.frame();
  assert.equal(h.simulation.getStats().alpha, .3);
  assert.ok(Math.abs(h.simulation.getPositions().e.x - before.e.x) > 10, '四跳邻居应跟随所在分量');
  h.simulation.dragEnd(); h.frame();
  assert.ok(h.simulation.getStats().alpha < .3 && h.simulation.getStats().alpha > .28);
  assert.equal(h.settles.length, 1, '只有拖动前的首次收敛，松手不立即结束');
});
