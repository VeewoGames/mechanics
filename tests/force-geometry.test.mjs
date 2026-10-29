import test from 'node:test';
import assert from 'node:assert/strict';
import { FORCE_DEFAULT_RADIUS, FORCE_NODE_SIZE, FORCE_NODE_TIERS, forceEdgeGeometry, forceGraphRoutes, forceNodeProfiles, forceNodeRadii, forceNodeRadius, forceEdgeRibbon, forceRouteSamples, forceRoutePoint } from '../src/web/force-geometry.mjs';
import { GraphCanvas } from '../src/web/canvas.mjs';

const { width, height } = FORCE_NODE_SIZE;
// 圆形节点画在锚定框中心；连线不得进入任一端点圆。const inside = (point, box, radius = FORCE_DEFAULT_RADIUS) => Math.hypot(point.x - box.x - width / 2, point.y - box.y - height / 2) < radius - 1e-6;
const sample = (route, t) => {
  const { start: a, end: b, controls } = route;
  const coordinate = key => controls.length === 2
    ? (1 - t) ** 3 * a[key] + 3 * (1 - t) ** 2 * t * controls[0][key] + 3 * (1 - t) * t ** 2 * controls[1][key] + t ** 3 * b[key]
    : controls.length === 1 ? (1 - t) ** 2 * a[key] + 2 * (1 - t) * t * controls[0][key] + t ** 2 * b[key]
      : (1 - t) * a[key] + t * b[key];
  return { x: coordinate('x'), y: coordinate('y') };
};
const classes = () => {
  const values = new Set();
  return { toggle(name, enabled) { if (enabled) values.add(name); else values.delete(name); }, contains: name => values.has(name) };
};
const node = id => ({ id, label: id });

test('直线、二次、三次、自环锥形有限且源粗目标细，轮廓顶点不进入端点圆', () => {
  const a = { x: 0, y: 0 }, b = { x: 350, y: 80 }, close = { x: 20, y: 0 };
  const cases = [[b, 'b', 0], [b, 'b', 45], [close, 'b', 0], [a, 'a', 0]];
  for (const [target, id, offset] of cases) for (const scale of [.1, .5, 1, 2]) {
    const route = forceEdgeGeometry(a, target, 'a', id, offset);
    const circles = [a, target].map(point => ({ x: point.x + width / 2, y: point.y + height / 2, radius: FORCE_DEFAULT_RADIUS }));
    const ribbon = forceEdgeRibbon(route, { scale, circles });
    assert.ok(ribbon.startWidth > ribbon.endWidth);
    assert.ok(ribbon.polygons.length > 0);
    for (const polygon of ribbon.polygons) for (const point of polygon.points) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      assert.equal(inside(point, a) || inside(point, target), false);
    }
    const unclipped = forceEdgeRibbon(route, { scale });
    const first = unclipped.polygons[0].points, last = unclipped.polygons.at(-1).points;
    const startWidth = Math.hypot(first[0].x - first.at(-1).x, first[0].y - first.at(-1).y);
    const middle = last.length / 2, endWidth = Math.hypot(last[middle - 1].x - last[middle].x, last[middle - 1].y - last[middle].y);
    assert.ok(startWidth > endWidth);
    assert.ok(Math.abs(startWidth * scale - 6) < 1e-6 && Math.abs(endWidth * scale - 1.25) < 1e-6);
  }
});

test('路线采样复用且弧长单调，自环渐变分段沿路线推进，结构断续宽度仍逐渐收窄', () => {
  const route = forceEdgeGeometry({ x: 0, y: 0 }, { x: 0, y: 0 }, 'a', 'a');
  const samples = forceRouteSamples(route); assert.equal(forceRouteSamples(route), samples);
  assert.ok(samples.length > 0); assert.ok(samples.points.every((point, index) => !index || point.distance >= samples.points[index - 1].distance));
  assert.deepEqual({ x: forceRoutePoint(samples, 0).x, y: forceRoutePoint(samples, 0).y }, route.start);
  assert.ok(Math.hypot(forceRoutePoint(samples, 1).x - route.end.x, forceRoutePoint(samples, 1).y - route.end.y) < 1e-6);
  const ribbon = forceEdgeRibbon(route); assert.equal(ribbon.polygons.length, 8);
  assert.equal(ribbon.polygons[0].from, 0); assert.equal(ribbon.polygons.at(-1).to, 1);
  const dashed = forceEdgeRibbon(route, { dash: [6, 4] });
  assert.ok(dashed.polygons.length > 1);
  assert.ok(dashed.polygons.every((polygon, index) => !index || polygon.from > dashed.polygons[index - 1].to));
  assert.throws(() => forceEdgeRibbon(route, { scale: 0 }), /无效/);
  assert.throws(() => forceRouteSamples({ start: { x: NaN, y: 0 }, end: route.end, controls: [] }), /有效路线/);
  const zero = forceEdgeRibbon({ start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, controls: [] });
  assert.ok(zero.polygons.every(polygon => polygon.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))));
});

test('力导向连线在各方向从圆周出发，不穿过自己的端点圆', () => {
  const a = { x: 0, y: 0 };
  for (const distance of [30, 60, 120, 260, 420]) for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 12) for (const offset of [-48, 0, 48]) {
    const b = { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
    const route = forceEdgeGeometry(a, b, 'a', 'b', offset);
    assert.match(route.path, /^M/); assert.doesNotMatch(route.path, /NaN|Infinity/);
    for (let step = 0; step <= 100; step++) {
      const point = sample(route, step / 100);
      assert.equal(inside(point, a) || inside(point, b), false, `方向 ${angle}、弯曲 ${offset}、进度 ${step} 进入端点`);
    }
    assert.ok(Number.isFinite(route.labelX) && Number.isFinite(route.labelY));
  }
});

test('反向和同向并行规则保持独立，不因翻转端点而重合', () => {
  const graph = { nodes: [node('a'), node('b')], edges: [
    { id: 'a-b', source: 'a', target: 'b', sign: 1 },
    { id: 'b-a', source: 'b', target: 'a', sign: -1 },
    { id: 'another-a-b', source: 'a', target: 'b', sign: 'random' },
  ] };
  const positions = { a: { x: 0, y: 0 }, b: { x: 420, y: 0 } }, before = structuredClone({ graph, positions });
  const routes = forceGraphRoutes(graph, positions);
  assert.equal(routes.size, 3);
  assert.equal(new Set([...routes.values()].map(route => sample(route, .5).y)).size, 3);
  assert.ok(routes.get('a-b').start.x < routes.get('a-b').end.x);
  assert.ok(routes.get('b-a').start.x > routes.get('b-a').end.x);
  assert.deepEqual({ graph, positions }, before);
});

test('紧贴的两圆端点留白相交时走外侧，不产生指回源节点的反向短线', () => {
  const a = { x: 0, y: 0 };
  for (const gap of [0, 4, 8]) {
    const b = { x: FORCE_DEFAULT_RADIUS * 2 + gap, y: 0 }, route = forceEdgeGeometry(a, b, 'a', 'b');
    assert.equal(route.controls.length, 2);
    for (let step = 0; step <= 100; step++) {
      const point = sample(route, step / 100);
      assert.equal(inside(point, a) || inside(point, b), false);
    }
  }
});

test('自环与重合端点有有限的可见路线，多个自环不重合', () => {
  const point = { x: 20, y: 30 };
  const loops = [0, 1, 2].map(index => forceEdgeGeometry(point, point, 'a', 'a', 0, index));
  assert.equal(new Set(loops.map(route => route.path)).size, 3);
  for (const route of loops) for (let step = 0; step <= 100; step++) assert.equal(inside(sample(route, step / 100), point), false);
  const overlap = forceEdgeGeometry(point, point, 'a', 'b');
  assert.doesNotMatch(overlap.path, /NaN|Infinity/);
  assert.notDeepEqual(overlap.start, overlap.end);
});

test('圆的大小随连接数增长且有上限，连线贴合各自半径', () => {
  assert.ok(forceNodeRadius(0) < forceNodeRadius(1) && forceNodeRadius(1) < forceNodeRadius(9));
  assert.equal(forceNodeRadius(1e6), forceNodeRadius(1e7));
  const hub = { x: 0, y: 0 }, leaf = { x: 300, y: 40 }, radii = { source: forceNodeRadius(25), target: forceNodeRadius(1) };
  for (const offset of [-30, 0, 30]) {
    const route = forceEdgeGeometry(hub, leaf, 'hub', 'leaf', offset, 0, radii);
    const center = { x: width / 2, y: height / 2 };
    assert.ok(Math.abs(Math.hypot(route.start.x - center.x, route.start.y - center.y) - radii.source - 4) < 1e-6, '起点落在枢纽圆外沿');
    for (let step = 0; step <= 100; step++) {
      const point = sample(route, step / 100);
      assert.equal(inside(point, hub, radii.source) || inside(point, leaf, radii.target), false);
    }
  }
  const graph = { nodes: ['hub', 'a', 'b', 'c'].map(node), edges: ['a', 'b', 'c'].map(id => ({ id: `hub-${id}`, source: 'hub', target: id })) };
  const routes = forceGraphRoutes(graph, { hub: { x: 0, y: 0 }, a: { x: 300, y: 0 }, b: { x: 0, y: 300 }, c: { x: -300, y: 0 } });
  assert.ok(Math.abs(routes.get('hub-a').start.x - width / 2 - forceNodeRadii(graph).get('hub') - 4) < 1e-6, '图级路线按节点档位取半径');
});

test('节点按图内排名分三档，枢纽明显大于普通节点', () => {
  // 一个大枢纽、四个次级枢纽、其余为叶子。
  const ids = Array.from({ length: 40 }, (_, index) => `n${index}`), edges = [];
  for (let index = 1; index < 40; index++) edges.push({ id: `hub-${index}`, source: 'n0', target: ids[index] });
  for (const mid of [1, 2, 3, 4]) for (let k = 0; k < 6; k++) edges.push({ id: `m${mid}-${k}`, source: ids[mid], target: ids[10 + mid * 6 + k] });
  const profiles = forceNodeProfiles({ nodes: ids.map(node), edges });
  assert.equal(profiles.get('n0').tier, 'core');
  for (const mid of ['n1', 'n2', 'n3']) assert.equal(profiles.get(mid).tier, 'secondary');
  assert.equal(profiles.get('n39').tier, 'normal');
  const core = profiles.get('n0').radius, leaf = profiles.get('n39').radius;
  assert.ok(core >= FORCE_NODE_TIERS.core.min && core <= FORCE_NODE_TIERS.core.max);
  assert.ok(core * core >= leaf * leaf * 8, '核心面积至少是普通节点的 8 倍');
  // 连接数均匀的小图不硬造枢纽。
  const ring = ['a', 'b', 'c', 'd'], flat = forceNodeProfiles({ nodes: ring.map(node), edges: ring.map((id, index) => ({ id: `r${index}`, source: id, target: ring[(index + 1) % 4] })) });
  assert.ok([...flat.values()].every(profile => profile.tier === 'normal'));
});

test('空图明确为空，坏引用或缺坐标明确失败，不静默漏边', () => {
  assert.deepEqual(forceGraphRoutes({ nodes: [], edges: [] }, {}), new Map());
  assert.throws(() => forceGraphRoutes({ nodes: [node('a')], edges: [{ id: 'bad', source: 'a', target: 'missing' }] }, { a: { x: 0, y: 0 } }), /missing/);
  assert.throws(() => forceGraphRoutes({ nodes: [node('a')], edges: [] }, {}), /a/);
  assert.throws(() => forceEdgeGeometry({ x: NaN, y: 0 }, { x: 0, y: 0 }, 'a', 'b'), /有效端点/);
});

test('力导向画布绕过旧路线缓存与 Worker，继续使用最终结构投影', async () => {
  const canvas = Object.create(GraphCanvas.prototype), requests = [];
  Object.assign(canvas, { positions: {}, root: { classList: classes() }, draw() {},
    callbacks: { computeGraph: request => requests.push(request) }, routeArchive: new Map() });
  const graph = { nodes: [node('child'), node('parent'), node('effect')], edges: [
    { id: 'parent-rule', source: 'child', target: 'parent', relation: 'specializes' },
    { id: 'effect-rule', source: 'child', target: 'effect', relation: 'influence', sign: 1 },
  ] };
  const positions = { child: { x: 0, y: 0 }, parent: { x: 0, y: -200 }, effect: { x: 400, y: 0 } };
  await canvas.update(graph, positions, null, null, false, { layoutMode: 'force', deferRouting: true,
    taxonomyPresentation: { mode: 'label', expandedNodeIds: [] }, retainedNodeIds: ['child'] });
  assert.deepEqual(canvas.graph.nodes.map(item => item.id), ['child', 'effect']);
  assert.deepEqual([...canvas.routed.keys()], ['effect-rule']);
  assert.equal(requests.length, 0);
  assert.equal(canvas.hideUnroutedEdges, false);
  assert.equal(canvas.root.classList.contains('force-graph'), true);
});

test('邻接聚焦只突出直接关联，边选择只突出该边和两个端点', () => {
  const canvas = Object.create(GraphCanvas.prototype);
  Object.assign(canvas, { layoutMode: 'force', graph: { nodes: ['a', 'b', 'c'].map(node), edges: [
    { id: 'ab', source: 'a', target: 'b' }, { id: 'bc', source: 'b', target: 'c' },
  ] }, nodeElements: new Map(['a', 'b', 'c'].map(id => [id, { classList: classes() }])),
  edgeElements: new Map(['ab', 'bc'].map(id => [id, { group: { classList: classes() } }])), selection: { type: 'node', id: 'a' } });
  canvas.applyAttention();
  assert.equal(canvas.nodeElements.get('a').classList.contains('is-focus-center'), true);
  assert.equal(canvas.nodeElements.get('b').classList.contains('is-focus-neighbor'), true);
  assert.equal(canvas.nodeElements.get('c').classList.contains('is-muted'), true);
  assert.equal(canvas.edgeElements.get('bc').group.classList.contains('is-muted'), true);
  canvas.selection = { type: 'edge', id: 'bc' }; canvas.applyAttention();
  assert.equal(canvas.nodeElements.get('a').classList.contains('is-muted'), true);
  assert.equal(canvas.edgeElements.get('bc').group.classList.contains('is-related'), true);
  canvas.selection = null; canvas.applyAttention();
  assert.equal(canvas.nodeElements.get('a').classList.contains('is-muted'), false);
  canvas.selection = { type: 'node', id: 'hidden-parent' }; canvas.applyAttention();
  assert.equal([...canvas.nodeElements.values()].some(element => element.classList.contains('is-muted')), false);
});

test('力导向拖动只更新邻边，预览分轨与松手绘制一致，并保留自环', () => {
  const canvas = Object.create(GraphCanvas.prototype), writes = new Map();
  const element = id => ({ setAttribute: (key, value) => writes.set(`${id}:${key}`, value) });
  const graph = { nodes: ['a', 'b', 'c'].map(node), edges: [
    { id: 'a-b', source: 'a', target: 'b' }, { id: 'a_b', source: 'b', target: 'a' },
    { id: 'loop', source: 'a', target: 'a' }, { id: 'b-c', source: 'b', target: 'c' },
  ] };
  const previous = { a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, c: { x: 800, y: 0 } };
  const positions = { ...previous, a: { x: 40, y: 90 } };
  Object.assign(canvas, { layoutMode: 'force', graph, positions: previous, routed: forceGraphRoutes(graph, previous),
    nodeElements: new Map(graph.nodes.map(item => [item.id, element(item.id)])),
    edgeElements: new Map(graph.edges.map(edge => [edge.id, { hit: element(`${edge.id}:hit`), line: element(`${edge.id}:line`), label: element(`${edge.id}:label`) }])) });
  canvas.renderIncremental(['a'], positions, previous);
  const finalRoutes = forceGraphRoutes(graph, positions);
  for (const id of ['a-b', 'a_b', 'loop']) {
    assert.equal(writes.get(`${id}:line:d`), finalRoutes.get(id).path);
    assert.equal(writes.get(`${id}:hit:d`), finalRoutes.get(id).path);
  }
  assert.equal(writes.has('b:transform'), false);
  assert.equal(writes.has('b-c:line:d'), false);
  assert.equal(writes.get('a:transform'), 'translate(40 90)');
});

test('从力导向返回默认展示时不复用曲线路线缓存', async () => {
  const canvas = Object.create(GraphCanvas.prototype), requests = [];
  Object.assign(canvas, { positions: {}, root: { classList: classes() }, draw() {}, callbacks: {},
    requestRouting: (...args) => { requests.push(args); return Promise.resolve(true); } });
  const graph = { nodes: [node('a'), node('b')], edges: [{ id: 'ab', source: 'a', target: 'b' }] };
  const positions = { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } };
  await canvas.update(graph, positions, null, null, false, { layoutMode: 'force' });
  assert.equal(canvas.routed.size, 1);
  await canvas.update(graph, positions, null, null, false, { preserveRoutes: true });
  assert.equal(requests.length, 1);
  assert.equal(canvas.routed.size, 0);
  assert.equal(canvas.root.classList.contains('force-graph'), false);
});

test('从力导向返回已存视图时消费匹配的新预置路线，不触发重算或清空调用方缓存', async () => {
  const canvas = Object.create(GraphCanvas.prototype), requests = [];
  Object.assign(canvas, { positions: {}, root: { classList: classes() }, draw() {}, callbacks: {},
    requestRouting: (...args) => { requests.push(args); return Promise.resolve(true); } });
  const graph = { nodes: [node('a'), node('b')], edges: [{ id: 'ab', source: 'a', target: 'b' }] };
  const forcePositions = { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } };
  const restoredPositions = { a: { x: 0, y: 0 }, b: { x: 600, y: 0 } };
  const restoredRoutes = new Map([['ab', { points: [{ x: 166, y: 31 }, { x: 600, y: 31 }] }]]);
  await canvas.update(graph, forcePositions, null, null, false, { layoutMode: 'force' });
  canvas.primeRoutes(graph, restoredPositions, restoredRoutes);
  await canvas.update(graph, restoredPositions, null, null, false, { preserveRoutes: true, deferRouting: true });
  assert.equal(canvas.routed, restoredRoutes);
  assert.equal(canvas.hideUnroutedEdges, false);
  assert.equal(canvas.primedRoutes, null);
  assert.equal(requests.length, 0);
  await canvas.update(graph, forcePositions, null, null, false, { layoutMode: 'force' });
  assert.equal(restoredRoutes.size, 1);
});

test('模式切换拒绝几何不匹配的预置路线，目标为力导向时始终清除预置路线', async () => {
  const canvas = Object.create(GraphCanvas.prototype), requests = [];
  Object.assign(canvas, { positions: {}, root: { classList: classes() }, draw() {}, callbacks: {},
    requestRouting: (...args) => { requests.push(args); return Promise.resolve(true); } });
  const graph = { nodes: [node('a'), node('b')], edges: [{ id: 'ab', source: 'a', target: 'b' }] };
  const positions = { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } };
  const stalePositions = { ...positions, b: { x: 600, y: 0 } };
  const routes = new Map([['ab', { points: [{ x: 166, y: 31 }, { x: 600, y: 31 }] }]]);
  await canvas.update(graph, positions, null, null, false, { layoutMode: 'force' });
  canvas.primeRoutes(graph, stalePositions, routes);
  await canvas.update(graph, positions, null, null, false);
  assert.equal(canvas.primedRoutes, null);
  assert.equal(canvas.routed.size, 0);
  assert.equal(requests.length, 1);
  canvas.primeRoutes(graph, positions, routes);
  await canvas.update(graph, positions, null, null, false, { layoutMode: 'force' });
  assert.equal(canvas.primedRoutes, null);
  assert.notEqual(canvas.routed, routes);
  assert.equal(canvas.routed.get('ab').path, forceGraphRoutes(graph, positions).get('ab').path);
  assert.equal(requests.length, 1);
});

test('定位概念只更新相机，保留布局和选择，隐藏或不存在的概念不跳转', () => {
  const canvas = Object.create(GraphCanvas.prototype), selection = { type: 'edge', id: 'selected' };
  Object.assign(canvas, { graph: { nodes: [node('a')], edges: [] }, positions: { a: { x: 800, y: 900 } },
    root: { clientWidth: 1200, clientHeight: 800 }, camera: { x: 0, y: 0, scale: .2 }, selection, transform() {} });
  assert.equal(canvas.focusNode('a'), true);
  assert.equal(canvas.camera.scale, .9);
  assert.equal(canvas.camera.x + (800 + width / 2) * canvas.camera.scale, 600);
  assert.equal(canvas.camera.y + (900 + height / 2) * canvas.camera.scale, 400);
  assert.equal(canvas.selection, selection);
  assert.deepEqual(canvas.positions, { a: { x: 800, y: 900 } });
  assert.equal(canvas.focusNode('absent'), false);
});

test('力导向适应画布将全部卡片放进安全区域，避开顶部搜索和底部工具栏', () => {
  const canvas = Object.create(GraphCanvas.prototype);
  Object.assign(canvas, { layoutMode: 'force', root: { clientWidth: 1000, clientHeight: 720 },
    graph: { nodes: [node('a'), node('b')], edges: [] },
    positions: { a: { x: -300, y: -500 }, b: { x: 1500, y: 1700 } }, transform() {} });
  for (const multiplier of [1, 10]) {
    canvas.positions.b = { x: 1500 * multiplier, y: 1700 * multiplier };
    canvas.fit();
    for (const point of Object.values(canvas.positions)) {
      assert.ok(point.x * canvas.camera.scale + canvas.camera.x >= 32 - 1e-6);
      assert.ok((point.x + width) * canvas.camera.scale + canvas.camera.x <= 1000 - 32 + 1e-6);
      assert.ok(point.y * canvas.camera.scale + canvas.camera.y >= 100 - 1e-6);
      assert.ok((point.y + height) * canvas.camera.scale + canvas.camera.y <= 720 - 110 + 1e-6);
    }
  }
});

test('力导向定位使用安全区域中心，并允许应用增加详情栏留白', () => {
  const canvas = Object.create(GraphCanvas.prototype);
  Object.assign(canvas, { layoutMode: 'force', root: { clientWidth: 1000, clientHeight: 720 },
    graph: { nodes: [node('a')], edges: [] }, positions: { a: { x: 800, y: 900 } },
    camera: { scale: .2 }, transform() {} });
  const center = () => ({ x: canvas.camera.x + (800 + width / 2) * canvas.camera.scale,
    y: canvas.camera.y + (900 + height / 2) * canvas.camera.scale });
  const expectCenter = (x, y) => { assert.ok(Math.abs(center().x - x) < 1e-6); assert.ok(Math.abs(center().y - y) < 1e-6); };
  canvas.focusNode('a');
  expectCenter(500, 355);
  canvas.callbacks = { getViewportInsets: () => ({ right: 340, top: 120, left: 0 }) };
  canvas.focusNode('a');
  expectCenter(346, 365);
  assert.equal(canvas.camera.scale, .9);
  canvas.fit();
  expectCenter(346, 365);
  canvas.callbacks.getViewportInsets = () => ({ right: 340, top: 180 });
  canvas.fit();
  expectCenter(346, 395);
});
