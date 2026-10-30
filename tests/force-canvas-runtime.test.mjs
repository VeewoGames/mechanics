import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { GraphCanvas } from '../src/web/canvas.mjs';

function harness(t, graph = { nodes: ['a', 'b', 'c'].map(id => ({ id, label: id })), edges: [
  { id: 'ab', source: 'a', target: 'b', relation: 'influence', sign: 1, ruleText: '增加' },
  { id: 'bc', source: 'b', target: 'c', relation: 'influence', sign: -1, ruleText: '减少' },
] }, positions = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, c: { x: 600, y: 0 } }, { raster = false, text = false } = {}) {
  const previousDocument = globalThis.document;
  t.after(() => { globalThis.document = previousDocument; });
  const writes = [], calls = [], paints = [];
  const context = Object.fromEntries(['setTransform', 'clearRect', 'translate', 'scale', 'setLineDash', 'beginPath', 'moveTo', 'lineTo',
    'quadraticCurveTo', 'bezierCurveTo', 'stroke', 'closePath', 'fill', 'arc', 'roundRect', 'rect', 'fillRect', 'strokeRect'].map(name =>
    [name, (...args) => paints.push({ name, args, alpha: context.globalAlpha, fill: context.fillStyle, stroke: context.strokeStyle, lineWidth: context.lineWidth })]));
  context.createLinearGradient = (...args) => {
    const gradient = { args, stops: [], addColorStop(offset, color) { this.stops.push([offset, color]); } };
    paints.push({ name: 'gradient', gradient }); return gradient;
  };
  if (text) {
    for (const name of ['fillText', 'strokeText', 'save', 'restore']) context[name] = (...args) => paints.push({ name, args, fill: context.fillStyle });
    context.measureText = value => ({ width: [...value].length * 7 });
  }
  const element = tag => {
    const classes = new Set();
    return { tag, attrs: {}, children: [], style: { setProperty() {} },
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
      setAttribute(key, value) { this.attrs[key] = value; writes.push({ element: this, key, value }); },
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; }, addEventListener() {}, remove() {},
    };
  };
  globalThis.document = { createElementNS: (_, tag) => element(tag), createElement: tag => ({ ...element(tag), getContext: () => context }) };
  const root = element('svg');
  Object.assign(root, { clientWidth: 1200, clientHeight: 720, getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} });
  if (raster) root.parentElement = { children: [], insertBefore(layer) { this.children.push(layer); } };
  const canvas = Object.create(GraphCanvas.prototype);
  Object.assign(canvas, { root, graph: { nodes: [], edges: [] }, positions: {}, mode: 'select', tooltipsEnabled: true, camera: { x: 0, y: 0, scale: 1 },
    callbacks: { name: () => { throw new Error('完整节点标签不应逐边回退到应用 find'); }, zoom() {},
      canMove: () => true, select: value => canvas.updateSelection(value), snapEnabled: () => true,
      move: value => calls.push(['move', structuredClone(value)]),
      forceDragStart: ids => calls.push(['start', ids]), forceDragMove: (ids, value) => calls.push(['drag', ids, structuredClone(value)]),
      forceDragEnd: () => calls.push(['end']), forceDragCancel: () => calls.push(['cancel']), hint() {},
    } });
  canvas.update(graph, positions, null, null, false, { layoutMode: 'force' });
  const event = (x, y, node = 'a') => ({ clientX: x, clientY: y, button: 0, pointerId: 1, preventDefault() {},
    target: { closest: selector => node && selector === '[data-node]' ? { dataset: { node } } : null } });
  writes.length = 0;
  return { canvas, calls, writes, event, paints };
}

function largeGraph(count = 350, edgeCount = 2) {
  const nodes = Array.from({ length: count }, (_, index) => ({ id: `n${index}`, label: `概念 ${index}` }));
  const edges = Array.from({ length: edgeCount }, (_, index) => ({ id: `e${index}`, source: `n${index % count}`,
    target: `n${(index + 1 + Math.floor(index / count)) % count}`, relation: 'influence', sign: 1, ruleText: '增加目标' }));
  const positions = Object.fromEntries(nodes.map((node, index) => [node.id, { x: index % 40 * 220, y: Math.floor(index / 40) * 120 }]));
  return { graph: { nodes, edges }, positions };
}

test('悬停只解释选中概念和关联连线，不覆盖点击选择与邻接聚焦', t => {
  const { canvas } = harness(t);
  canvas.updateSelection({ type: 'node', id: 'a' });
  canvas.tooltipTarget = GraphCanvas.prototype.tooltipTarget.bind(canvas);
  const tooltips = []; canvas.showTooltip = event => tooltips.push(event);
  const over = id => ({ target: { closest: () => ({ dataset: { node: id } }) } });
  canvas.moveRasterHover(over('c')); canvas.applyAttention();
  assert.deepEqual(canvas.selection, { type: 'node', id: 'a' });
  assert.equal(tooltips.length, 0);
  assert.equal(canvas.nodeElements.get('a').classList.contains('is-focus-center'), true);
  assert.equal(canvas.nodeElements.get('c').classList.contains('is-muted'), true);
  canvas.updateSelection(null); canvas.moveRasterHover(over('c')); canvas.applyAttention();
  assert.equal(tooltips.length, 1);
  assert.equal(canvas.nodeElements.get('c').classList.contains('is-focus-center'), false);
});

test('大图普通连线使用中性灰屏幕一像素细线，高亮后用渐变锥形填充', t => {
  const { graph, positions } = largeGraph(), { canvas, paints } = harness(t, graph, positions, { raster: true });
  canvas.camera.scale = .2; canvas.transform();
  assert.ok(paints.some(paint => paint.name === 'stroke' && paint.stroke === 'rgb(60,66,78)' && Math.abs(paint.lineWidth * .2 - 1) < 1e-6));
  canvas.updateSelection({ type: 'node', id: 'n0' }); paints.length = 0; canvas.drawForceRaster();
  assert.ok(paints.some(paint => paint.name === 'fill' && paint.fill?.stops?.[0]?.[1] === '#328577ff'));
  canvas.tooltipTarget = () => ({ dataset: { node: 'n200' } }); canvas.showTooltip = () => {};
  canvas.moveRasterHover({}); paints.length = 0; canvas.drawForceRaster();
  assert.deepEqual(canvas.selection, { type: 'node', id: 'n0' });
  assert.ok(paints.some(paint => paint.name === 'fill' && paint.fill?.stops?.[1]?.[1] === '#32857759'));
  const ribbon = canvas.forceRasterRouteCache.get('e0').ribbon;
  assert.ok(ribbon.startWidth > ribbon.endWidth);
});

test('高亮层数不裁剪画布或布局输入，切换层数保留全部关系与位置', t => {
  const { canvas } = harness(t), graph = canvas.graph, positions = structuredClone(canvas.positions);
  canvas.update(graph, positions, null, { type: 'node', id: 'a' }, false, { layoutMode: 'force', highlightDepth: 1 });
  assert.deepEqual(canvas.graph.nodes.map(node => node.id), ['a', 'b', 'c']);
  assert.deepEqual([...canvas.edgeElements.keys()], ['ab', 'bc']);
  assert.deepEqual([...canvas.forceFocusState().relatedNodes], ['a', 'b']);
  const version = canvas.forceFrameVersion;
  canvas.setHighlightDepth(2);
  assert.deepEqual([...canvas.forceFocusState().relatedNodes], ['a', 'b', 'c']);
  assert.equal(canvas.forceFrameVersion, version);
  assert.equal(canvas.graph.nodes.length, 3); assert.equal(canvas.edgeElements.size, 2);
  assert.deepEqual(canvas.positions, positions);
});

test('单画布增量帧保持坐标对象与索引，图切换拒绝旧帧', t => {
  const { canvas, paints, writes } = harness(t, undefined, undefined, { raster: true });
  const point = canvas.positions.a, version = canvas.forceFrameVersion, adjacency = canvas.forceAdjacentEdges;
  canvas.forceHitGrid(); paints.length = 0; writes.length = 0;
  canvas.updateForcePositions({ a: { x: 22, y: 18 } }, version);
  assert.equal(canvas.positions.a, point); assert.deepEqual(point, { x: 22, y: 18 });
  assert.equal(canvas.forceAdjacentEdges, adjacency); assert.equal(canvas.forceHitIndex, null);
  assert.ok(paints.some(paint => paint.name === 'arc' && paint.args[0] === 105 && paint.args[1] === 49));
  assert.equal(writes.length, 0); assert.equal(canvas.nodeElements.size, 0);
  canvas.update({ nodes: [{ id: 'a', label: '新概念' }], edges: [] }, { a: { x: 90, y: 120 } }, null, null, false, { layoutMode: 'force' });
  assert.equal(canvas.updateForcePositions({ a: { x: 999, y: 999 } }, version), false);
  assert.deepEqual(canvas.positions.a, { x: 90, y: 120 });
});

test('单画布悬停有说明和手型且保留选择，无画布环境保留 SVG 提示', t => {
  const { canvas, event } = harness(t, undefined, undefined, { raster: true });
  canvas.showTooltip = () => {}; canvas.updateSelection({ type: 'node', id: 'b' });
  const pointer = event(383, 31, null);
  assert.equal(canvas.tooltipTarget(pointer).dataset.tooltip, 'b');
  canvas.moveRasterHover(pointer);
  assert.equal(canvas.root.classList.contains('force-hover'), true);
  assert.deepEqual(canvas.selection, { type: 'node', id: 'b' });
  canvas.clearRasterHover(true); assert.equal(canvas.root.classList.contains('force-hover'), false);
  canvas.updateSelection(null); canvas.moveRasterHover(pointer);
  assert.equal(canvas.forceFocusState().attention, false, '悬停不临时改变整图的选择聚焦');
  canvas.forceRasterActive = false;
  assert.equal(canvas.tooltipTarget({ target: { closest: () => ({ dataset: { node: 'a' } }) } }).dataset.node, 'a');
});

test('单画布方向键按空间切换节点，Enter 选择并支持移动到屏外节点', t => {
  const { canvas } = harness(t, undefined, undefined, { raster: true });
  canvas.updateSelection({ type: 'node', id: 'a' });
  const key = value => ({ key: value, preventDefault() {} });
  assert.equal(canvas.forceKeyboard(key('ArrowRight')), true);
  assert.deepEqual(canvas.selection, { type: 'node', id: 'b' });
  canvas.updateForcePositions({ c: { x: 5000, y: 0 } });
  canvas.forceKeyboard(key('ArrowRight'));
  assert.deepEqual(canvas.selection, { type: 'node', id: 'c' }); assert.ok(canvas.camera.x < 0);
  assert.match(canvas.root.attrs['aria-label'], /c/);
  assert.equal(canvas.forceKeyboard(key('Enter')), true);
});

test('悬停连线只强化该边并显示三个光点，不改变节点选择或灰线样式', t => {
  const { canvas, paints, event } = harness(t, undefined, undefined, { raster: true });
  canvas.tooltipsEnabled = true;
  canvas.tooltip = { hidden: true, style: {}, offsetWidth: 100, offsetHeight: 30 };
  for (const selection of [null, { type: 'node', id: 'a' }]) {
    canvas.clearRasterHover(true); canvas.updateSelection(selection); paints.length = 0;
    canvas.moveRasterHover(event(233, 31, null));
    assert.equal(canvas.forceHoverEdgeId, 'ab');
    assert.equal(canvas.tooltip.hidden, false); assert.equal(canvas.tooltip.textContent, '增加');
    assert.deepEqual(canvas.selection, selection);
    assert.equal(canvas.forceRasterRouteCache.get('ab').ribbon.startWidth, 8);
    assert.equal(paints.filter(paint => paint.name === 'arc' && paint.args[2] === 2.5).length, 3);
  }
});

test('关闭悬浮说明后连线没有悬停效果，临时开启和释放立即恢复对应状态', t => {
  const { canvas, paints, event } = harness(t, undefined, undefined, { raster: true });
  canvas.tooltip = { hidden: true, style: {}, offsetWidth: 100, offsetHeight: 30 };
  const pointer = event(233, 31, null);
  for (const selection of [null, { type: 'node', id: 'a' }]) {
    canvas.clearRasterHover(true); canvas.updateSelection(selection); canvas.setTooltipsEnabled(false);
    paints.length = 0; canvas.drawForceRaster();
    const baseline = JSON.stringify(paints);
    canvas.moveRasterHover(pointer); paints.length = 0; canvas.drawForceRaster();
    assert.equal(JSON.stringify(paints), baseline, '经过连线不改变任何绘制样式');
    assert.equal(canvas.forceHoverEdgeId, null);
    assert.equal(canvas.root.classList.contains('force-hover'), false);
    assert.equal(canvas.tooltip.hidden, true);
    assert.deepEqual(canvas.hitForceRaster(pointer, true), { type: 'edge', id: 'ab' }, '仍可命中连线进行选择');
    paints.length = 0; canvas.setTooltipsEnabled(true);
    assert.equal(canvas.forceHoverEdgeId, 'ab', '按住 Shift 时无需再次移动指针');
    assert.equal(canvas.tooltip.hidden, false);
    assert.equal(canvas.root.classList.contains('force-hover'), true);
    assert.equal(canvas.forceRasterRouteCache.get('ab').ribbon.startWidth, 8);
    assert.equal(paints.filter(paint => paint.name === 'arc' && paint.args[2] === 2.5).length, 3);
    paints.length = 0; canvas.setTooltipsEnabled(false);
    assert.equal(canvas.forceHoverEdgeId, null, '松开 Shift 或关闭说明立即清除悬停');
    assert.equal(canvas.root.classList.contains('force-hover'), false);
    assert.equal(canvas.tooltip.hidden, true);
    assert.equal(paints.some(paint => paint.name === 'arc' && paint.args[2] === 2.5), false);
    assert.deepEqual(canvas.selection, selection);
  }
  canvas.updateSelection({ type: 'edge', id: 'ab' }); paints.length = 0; canvas.drawForceRaster();
  assert.equal(canvas.forceRasterRouteCache.get('ab').ribbon.startWidth, 8, '关闭说明仍保留点击选中的高亮');
  assert.equal(paints.filter(paint => paint.name === 'arc' && paint.args[2] === 2.5).length, 3);
  canvas.updateSelection(null); canvas.moveRasterHover(event(83, 31, null));
  assert.equal(canvas.forceRasterHoverId, 'a', '节点交互不受连线悬停开关影响');
});

test('临时开启说明使用指针当前位置，不恢复上一条连线的悬停', t => {
  const { canvas, event } = harness(t, undefined, undefined, { raster: true });
  canvas.tooltip = { hidden: true, style: {}, offsetWidth: 100, offsetHeight: 30 };
  canvas.setTooltipsEnabled(false);
  canvas.moveRasterHover(event(233, 31, null)); canvas.moveRasterHover(event(533, 31, null));
  canvas.setTooltipsEnabled(true);
  assert.equal(canvas.forceHoverEdgeId, 'bc'); assert.equal(canvas.tooltip.textContent, '减少');
  canvas.setTooltipsEnabled(false); canvas.moveRasterHover(event(233, 31, null));
  canvas.clearRasterHover(true); canvas.setTooltipsEnabled(true);
  assert.equal(canvas.forceHoverEdgeId, null, '离开画布后不会恢复旧位置的悬停');
});

test('移除力导向关系符号及箭头，节点名字保留，入边透明度为出边的六成', t => {
  const { canvas, paints } = harness(t, undefined, undefined, { raster: true, text: true });
  canvas.updateSelection({ type: 'node', id: 'b' }); paints.length = 0; canvas.drawForceRaster();
  const ribbons = paints.filter(paint => paint.name === 'fill' && paint.fill?.stops);
  assert.equal(ribbons.length, 2);
  assert.equal(ribbons.find(paint => paint.fill.stops[0][1] === '#328577ff').alpha, .6);
  assert.equal(ribbons.find(paint => paint.fill.stops[0][1] === '#bd7064ff').alpha, 1);
  assert.ok(paints.some(paint => paint.name === 'fillText' && paint.args[0] === 'b'));
  assert.equal(paints.some(paint => paint.name === 'fillText' && ['＋', '−', '？', 'is-a', 'part-of'].includes(paint.args[0])), false);
  assert.ok(paints.filter(paint => paint.name === 'closePath').length === 2, '只有两条锥形闭合轮廓，没有箭头三角形');
});

test('随机及结构关系只用既有类型色，结构锥形保留两种断续节奏而不绘制关系文字', t => {
  const graph = { nodes: ['a', 'b', 'c', 'd'].map(id => ({ id, label: id })), edges: [
    { id: 'ab', source: 'a', target: 'b', relation: 'specializes' },
    { id: 'cd', source: 'c', target: 'd', relation: 'part-of' },
    { id: 'bd', source: 'b', target: 'd', relation: 'influence', sign: 'random', ruleText: '随机影响' },
  ] };
  const positions = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, c: { x: 0, y: 200 }, d: { x: 300, y: 200 } };
  const { canvas, paints } = harness(t, graph, positions, { raster: true, text: true });
  canvas.camera.scale = .5; canvas.updateSelection({ type: 'nodes', ids: ['a', 'c'] });
  paints.length = 0; canvas.drawForceRaster();
  const colors = new Set(paints.filter(paint => paint.name === 'gradient').map(paint => paint.gradient.stops[0][1].slice(0, 7)));
  for (const color of ['#c49a26', '#4f7f9a', '#8b6fb3']) assert.ok(colors.has(color));
  for (const id of ['ab', 'cd']) {
    const polygons = canvas.forceRasterRouteCache.get(id).ribbon.polygons;
    assert.ok(polygons.length > 1); assert.ok(polygons[1].from > polygons[0].to);
  }
  assert.equal(paints.some(paint => paint.name === 'fillText' && ['＋', '−', '？', 'is-a', 'part-of'].includes(paint.args[0])), false);
});

test('流动帧仅在选中或悬停边时续订，清空、减少动态效果及退出画布均停止', t => {
  const { canvas, paints } = harness(t, undefined, undefined, { raster: true });
  const previousRAF = globalThis.requestAnimationFrame, queue = new Map(); let nextId = 0;
  globalThis.requestAnimationFrame = callback => { queue.set(++nextId, callback); return nextId; };
  t.after(() => { globalThis.requestAnimationFrame = previousRAF; });
  const frame = () => { const [id, run] = queue.entries().next().value; queue.delete(id); run(); };
  canvas.updateSelection({ type: 'edge', id: 'ab' }); assert.equal(queue.size, 1);
  frame(); assert.equal(queue.size, 1, '选中边连续播放，最多一帧排队');
  canvas.updateSelection(null); frame(); assert.equal(queue.size, 0);
  canvas.forceHoverEdgeId = 'ab'; canvas.requestRasterDraw(); frame(); assert.equal(queue.size, 1);
  canvas.forceMotionPreference.matches = true; paints.length = 0; frame(); assert.equal(queue.size, 0);
  const dot = paints.filter(paint => paint.name === 'arc' && paint.args[2] === 2.5);
  assert.equal(dot.length, 1);
  const route = canvas.routed.get('ab'); assert.ok(Math.abs(dot[0].args[0] - (route.start.x * .3 + route.end.x * .7)) < 1e-6);
  canvas.forceMotionPreference.matches = false; canvas.requestRasterDraw(); frame(); assert.equal(queue.size, 1);
  globalThis.document.hidden = true; frame(); assert.equal(queue.size, 0, '后台页面停止续订动画帧');
  globalThis.document.hidden = false; canvas.requestRasterDraw(); frame(); assert.equal(queue.size, 1);
  canvas.forceRasterActive = false; frame(); assert.equal(queue.size, 0);
});

test('流动点按源到目标前进，曲线采样及锥形在平移与动画帧复用', t => {
  const { canvas, paints } = harness(t, undefined, undefined, { raster: true });
  let now = 0; t.mock.method(performance, 'now', () => now);
  canvas.updateSelection({ type: 'edge', id: 'ab' }); paints.length = 0; canvas.drawForceRaster();
  const first = paints.find(paint => paint.name === 'arc' && paint.args[2] === 2.5).args[0];
  const ribbon = canvas.forceRasterRouteCache.get('ab').ribbon;
  now = 160; paints.length = 0; canvas.camera.x += 10; canvas.drawForceRaster();
  const second = paints.find(paint => paint.name === 'arc' && paint.args[2] === 2.5).args[0];
  assert.ok(second > first); assert.equal(canvas.forceRasterRouteCache.get('ab').ribbon, ribbon);
});

test('高亮边在粗起点一侧拓宽命中，细终点与静止关系维持原容差', t => {
  const { canvas, event } = harness(t, undefined, undefined, { raster: true });
  const sourceSide = event(140, 37, null), targetSide = event(330, 37, null);
  assert.equal(canvas.hitForceRaster(sourceSide, true), null);
  canvas.updateSelection({ type: 'node', id: 'a' });
  assert.deepEqual(canvas.hitForceRaster(sourceSide, true), { type: 'edge', id: 'ab' });
  assert.equal(canvas.hitForceRaster(targetSide, true), null);
});

test('选中概念后仅解释选中节点和高亮关系，多选取并集，边选择允许解释两端', t => {
  const { canvas, event } = harness(t, undefined, undefined, { raster: true });
  const node = id => event({ a: 83, b: 383, c: 683 }[id], 31, null);
  const edgeAB = event(233, 31, null), edgeBC = event(533, 31, null);
  canvas.updateSelection({ type: 'node', id: 'a' });
  assert.equal(canvas.tooltipTarget(node('a')).dataset.node, 'a');
  assert.equal(canvas.tooltipTarget(node('b')), null); assert.equal(canvas.tooltipTarget(node('c')), null);
  assert.equal(canvas.tooltipTarget(edgeAB).dataset.edge, 'ab'); assert.equal(canvas.tooltipTarget(edgeBC), null);
  canvas.setHighlightDepth(2); assert.equal(canvas.tooltipTarget(edgeBC).dataset.edge, 'bc');
  canvas.updateSelection({ type: 'nodes', ids: ['a', 'c'] });
  assert.equal(canvas.tooltipTarget(node('c')).dataset.node, 'c');
  canvas.updateSelection({ type: 'edge', id: 'bc' });
  assert.equal(canvas.tooltipTarget(node('b')).dataset.node, 'b');
  assert.equal(canvas.tooltipTarget(node('c')).dataset.node, 'c');
  assert.equal(canvas.tooltipTarget(node('a')), null); assert.equal(canvas.tooltipTarget(edgeAB), null);
  assert.equal(canvas.tooltipTarget(edgeBC).dataset.edge, 'bc');
});

test('切换选择或收窄高亮范围立即隐藏旧说明，清除选择后恢复自由悬停', t => {
  const { canvas, event } = harness(t, undefined, undefined, { raster: true });
  canvas.tooltipsEnabled = true;
  canvas.tooltip = { hidden: true, style: {}, offsetWidth: 100, offsetHeight: 30 };
  const edgeAB = event(233, 31, null), edgeBC = event(533, 31, null);
  canvas.moveRasterHover(edgeAB); assert.equal(canvas.tooltip.hidden, false);
  canvas.updateSelection({ type: 'node', id: 'c' });
  assert.equal(canvas.tooltip.hidden, true); assert.equal(canvas.forceHoverEdgeId, null);
  canvas.updateSelection({ type: 'node', id: 'a' }); canvas.setHighlightDepth(2);
  canvas.moveRasterHover(edgeBC); assert.equal(canvas.tooltip.hidden, false);
  canvas.setHighlightDepth(1); assert.equal(canvas.tooltip.hidden, true); assert.equal(canvas.forceHoverEdgeId, null);
  canvas.updateSelection(null); canvas.moveRasterHover(edgeBC);
  assert.equal(canvas.tooltip.hidden, false); assert.equal(canvas.tooltip.textContent, '减少');
});

test('相关连线没有说明时隐藏上一条提示，不沿用选中概念的解释', t => {
  const graph = { nodes: ['a', 'b'].map(id => ({ id, label: id })), edges: [
    { id: 'ab', source: 'a', target: 'b', relation: 'influence', sign: 1, ruleText: '' },
  ] };
  const { canvas, event } = harness(t, graph, undefined, { raster: true });
  canvas.tooltipsEnabled = true;
  canvas.tooltip = { hidden: true, style: {}, offsetWidth: 100, offsetHeight: 30 };
  canvas.updateSelection({ type: 'node', id: 'a' }); canvas.moveRasterHover(event(83, 31, null));
  assert.equal(canvas.tooltip.hidden, false); assert.equal(canvas.tooltip.textContent, 'a');
  canvas.moveRasterHover(event(233, 31, null)); assert.equal(canvas.tooltip.hidden, true);
});

test('单画布查找光环与起终点闪烁保持图版本，标签胶囊接受遮挡避让并可命中', t => {
  const { canvas, paints } = harness(t, undefined, undefined, { raster: true, text: true });
  const version = canvas.forceFrameVersion;
  canvas.setSearchMarks(['a', 'b'], 'a');
  assert.ok(paints.some(paint => paint.name === 'stroke' && paint.stroke === '#b38c36'));
  paints.length = 0; canvas.flashRoles();
  assert.ok(paints.some(paint => paint.name === 'stroke' && paint.stroke === '#1f8a6d'));
  assert.ok(paints.some(paint => paint.name === 'stroke' && paint.stroke === '#d07f1c'));
  assert.equal(canvas.forceFrameVersion, version);
  canvas.forceChipCache.set('a', { chips: [{ kind: 'badge', x: 0, width: 80, label: '父概念', targetId: 'b' }], more: null });
  let occupied = 0; canvas.forceChipHits = [];
  canvas.drawForceChips(canvas.forceRasterContext, { id: 'a' }, 100, 100, 'sans-serif', () => occupied++, () => true);
  assert.equal(occupied, 0); assert.equal(canvas.forceChipHits.length, 0);
  canvas.drawForceChips(canvas.forceRasterContext, { id: 'a' }, 100, 100, 'sans-serif', () => occupied++, () => false);
  assert.equal(occupied, 1); assert.equal(canvas.forceChipAt({ clientX: 100, clientY: 108 }), 'b');
  assert.ok(paints.some(paint => paint.name === 'fillText' && paint.args[0] === 'a'));
});

test('极低倍率悬停仍显示概念名称，拖动开始立即隐藏旧提示', t => {
  const { canvas, paints, event } = harness(t, undefined, undefined, { raster: true, text: true });
  canvas.camera.scale = .05; canvas.transform();
  canvas.forceRasterHoverId = 'a'; paints.length = 0; canvas.drawForceRaster();
  assert.ok(paints.some(paint => paint.name === 'fillText' && paint.args[0] === 'a'));
  canvas.tooltip = { hidden: false }; canvas.tooltipPointer = {};
  canvas.down(event(83 * .05, 31 * .05, null));
  assert.equal(canvas.tooltip.hidden, true); assert.equal(canvas.tooltipPointer, null);
});

test('力导向大图在所有倍率与节点定位时复用单画布并显示最新坐标', t => {
  const { graph, positions } = largeGraph(), { canvas, writes, paints } = harness(t, graph, positions, { raster: true });
  const world = canvas.world, version = canvas.forceFrameVersion;
  assert.equal(canvas.forceRasterActive, true);
  assert.equal(canvas.nodeElements.size, 0); assert.equal(canvas.edgeElements.size, 0);
  canvas.camera.scale = .1; canvas.transform();
  assert.equal(canvas.forceRasterActive, true); assert.equal(world.attrs.display, 'none');
  assert.equal(canvas.forceRasterLayer.hidden, false); assert.equal(canvas.root.parentElement.children.length, 1);
  canvas.zoom(.8, 0, 0);
  assert.ok(canvas.camera.scale < .1, '适应大图后向外缩放不能反跳至旧最小倍率');
  writes.length = 0; paints.length = 0;
  canvas.updateForcePositions({ n0: { x: 100.5, y: 90.25 } }, version);
  assert.equal(writes.length, 0, '光栅帧不写隐藏的 SVG 属性');
  assert.ok(paints.some(paint => paint.name === 'arc' && paint.args[0] === 100.5 + 83 && paint.args[1] === 90.25 + 31), '圆心随锚定框中心移动');
  assert.equal(canvas.world, world); assert.equal(canvas.forceFrameVersion, version);
  canvas.focusNode('n0');
  assert.equal(canvas.forceRasterActive, true); assert.equal(world.attrs.display, 'none');
  assert.equal(canvas.forceRasterLayer.hidden, false);
  assert.equal(canvas.nodeElements.size, 0); assert.equal(canvas.edgeElements.size, 0);
  assert.deepEqual(canvas.hitForceRaster({ clientX: canvas.camera.x + 183.5 * canvas.camera.scale,
    clientY: canvas.camera.y + 121.25 * canvas.camera.scale }), { type: 'node', id: 'n0' });
  canvas.camera.scale = .1; canvas.transform();
  assert.equal(canvas.root.parentElement.children.length, 1, '缩放往返应复用同一轻量图层');
});

test('光栅节点依世界坐标命中，隐藏 SVG 后仍能选择和牵引，边保持可命中', t => {
  const { graph, positions } = largeGraph(), { canvas, calls, event } = harness(t, graph, positions, { raster: true });
  canvas.camera = { x: 100, y: 100, scale: .2 }; canvas.transform();
  const onNode = event(110, 106, null), onEdge = event(138.6, 106.2, null);
  assert.deepEqual(canvas.hitForceRaster(onNode, true), { type: 'node', id: 'n0' });
  assert.deepEqual(canvas.hitForceRaster(onEdge, true), { type: 'edge', id: 'e0' });
  canvas.down(onNode); canvas.up(onNode);
  assert.deepEqual(canvas.selection, { type: 'node', id: 'n0' });
  canvas.callbacks.quickLink = id => calls.push(['quickLink', id]);
  canvas.down(onNode); canvas.up(onNode);
  assert.deepEqual(calls.find(call => call[0] === 'quickLink'), ['quickLink', 'n0']);
  canvas.down(onNode); canvas.move(event(120, 116, null)); canvas.up(event(120, 116, null));
  assert.deepEqual(canvas.positions.n0, { x: 50, y: 50 });
  assert.equal(calls.filter(call => call[0] === 'start').length, 1);
  assert.equal(calls.filter(call => call[0] === 'end').length, 1);
  assert.equal(calls.some(call => call[0] === 'move'), false);
});

test('停止运动后调整侧栏宽度仍更新光栅尺寸，避免缩放拉伸造成命中错位', t => {
  const previousObserver = globalThis.ResizeObserver;
  let resized, observed;
  globalThis.ResizeObserver = class { constructor(callback) { resized = callback; } observe(root) { observed = root; } };
  t.after(() => { globalThis.ResizeObserver = previousObserver; });
  const { graph, positions } = largeGraph(), { canvas, paints, event } = harness(t, graph, positions, { raster: true });
  canvas.camera = { x: 100, y: 100, scale: .2 }; canvas.transform();
  assert.equal(observed, canvas.root);
  const version = canvas.forceFrameVersion;
  canvas.root.clientWidth = 800; paints.length = 0; resized();
  assert.deepEqual(paints.find(paint => paint.name === 'clearRect').args, [0, 0, 800, 720]);
  assert.equal(canvas.forceRasterLayer.width, Math.round(800 * Math.min(2, globalThis.devicePixelRatio || 1)));
  assert.deepEqual(canvas.hitForceRaster(event(110, 106, null)), { type: 'node', id: 'n0' });
  assert.equal(canvas.forceFrameVersion, version);
});

test('光栅同色批量描边覆盖完整大图，各倍率仅高亮边使用锥形而无箭头', t => {
  const { graph, positions } = largeGraph(1493, 2702), { canvas, paints, writes } = harness(t, graph, positions, { raster: true });
  canvas.camera.scale = .1; canvas.transform(); paints.length = 0; writes.length = 0;
  canvas.drawForceRaster();
  assert.equal(paints.filter(paint => paint.name === 'arc').length, 1493, '每个圆形节点仍完整绘制');
  assert.equal(canvas.forceRasterEdges.length, 2702, '全部关系保留并可命中');
  assert.ok(paints.filter(paint => paint.name === 'stroke' || paint.name === 'fill').length < 20, '同色图元合并绘制提交');
  assert.equal(paints.filter(paint => paint.name === 'closePath').length, 0, '无焦点时只画灰线');
  assert.equal(writes.length, 0);
  paints.length = 0; canvas.updateSelection({ type: 'node', id: 'n0' });
  assert.equal(paints.filter(paint => paint.name === 'closePath').length, canvas.forceFocusState().relatedEdges.size);
  assert.ok(paints.some(paint => paint.name === 'stroke' && paint.stroke === 'rgb(60,66,78)' && paint.alpha > 0 && paint.alpha < .1), '保留非相关关系并淡化');
  paints.length = 0; canvas.camera.scale = .2; canvas.transform();
  assert.equal(paints.filter(paint => paint.name === 'closePath').length, canvas.forceFocusState().relatedEdges.size, '低倍率也以锥形表达方向');
  paints.length = 0; canvas.camera.scale = .4; canvas.transform();
  assert.equal(paints.filter(paint => paint.name === 'closePath').length, canvas.forceFocusState().relatedEdges.size, '放大不为静止关系增加方向标记');
});

test('力导向回退帧复用 DOM 与邻接索引并原地更新坐标，旧版本帧不能覆盖新图', t => {
  const { canvas, writes } = harness(t);
  const world = canvas.world, nodes = canvas.nodeElements, edges = canvas.edgeElements, version = canvas.forceFrameVersion;
  const index = canvas.forceAdjacentEdges, originalA = canvas.positions.a;
  canvas.graph.nodes.find = () => { throw new Error('帧更新不能逐边搜索节点'); };
  canvas.graph.edges.find = () => { throw new Error('帧更新不能搜索边数组'); };
  assert.equal(canvas.updateForcePositions({ a: { x: 11.5, y: 17.25 } }, version), true);
  assert.equal(canvas.world, world); assert.equal(canvas.nodeElements, nodes); assert.equal(canvas.edgeElements, edges);
  assert.equal(canvas.forceAdjacentEdges, index);
  assert.equal(canvas.positions.a, originalA);
  assert.deepEqual(originalA, { x: 11.5, y: 17.25 });
  assert.equal(nodes.get('a').attrs.transform, 'translate(11.5 17.25)');
  assert.ok(writes.some(write => write.element === edges.get('ab').line && write.key === 'd'));
  assert.equal(writes.some(write => write.element === edges.get('bc').line), false);
  writes.length = 0;
  canvas.updateForcePositions({ a: { x: 11.5, y: 17.25 } }, version);
  assert.equal(writes.length, 0, '静止帧不重复写 DOM');
  const nextGraph = { nodes: [{ id: 'a', label: '新的甲' }], edges: [] };
  canvas.update(nextGraph, { a: { x: 90, y: 120 } }, 'next', null, false, { layoutMode: 'force' });
  writes.length = 0;
  assert.equal(canvas.updateForcePositions({ a: { x: 999, y: 999 } }, version), false);
  assert.deepEqual(canvas.positions.a, { x: 90, y: 120 });
  assert.equal(writes.length, 0);
});

test('屏外帧仍保留坐标但不写节点 DOM，平移进入视口时补齐位置与连线', t => {
  const { canvas, writes } = harness(t);
  canvas.updateForcePositions({ c: { x: 5000, y: 6000 } });
  assert.equal(canvas.nodeElements.get('c').attrs.display, 'none');
  writes.length = 0;
  canvas.updateForcePositions({ c: { x: 5100, y: 6100 } });
  assert.deepEqual(canvas.positions.c, { x: 5100, y: 6100 });
  assert.equal(writes.some(write => write.element === canvas.nodeElements.get('c')), false);
  canvas.camera = { x: -5000, y: -6000, scale: 1 }; canvas.transform();
  assert.equal(canvas.nodeElements.get('c').attrs.display, 'inline');
  assert.equal(canvas.nodeElements.get('c').attrs.transform, 'translate(5100 6100)');
  assert.notEqual(canvas.edgeElements.get('bc').group.attrs.display, 'none');
});

test('真正拖动后只启动一次牵引，实时帧不中断手势，松手仅通知一次且不吸附网格', t => {
  const { canvas, calls, event } = harness(t);
  canvas.down(event(10, 10)); canvas.move(event(12, 11));
  assert.deepEqual(calls, []);
  canvas.move(event(21.5, 27.25));
  const gesture = canvas.gesture;
  canvas.updateForcePositions({ b: { x: 315, y: 12 } });
  assert.equal(canvas.gesture, gesture);
  canvas.up(event(21.5, 27.25));
  assert.equal(calls.filter(call => call[0] === 'start').length, 1);
  assert.equal(calls.filter(call => call[0] === 'end').length, 1);
  assert.equal(calls.some(call => call[0] === 'move'), false);
  assert.deepEqual(canvas.positions.a, { x: 11.5, y: 17.25 });
  assert.deepEqual(canvas.positions.b, { x: 315, y: 12 });
});

test('取消或拖动中权限失效均取消牵引，不触发落地提交', t => {
  const { canvas, calls, event } = harness(t);
  canvas.down(event(10, 10)); canvas.move(event(25, 30)); canvas.cancel();
  assert.equal(calls.filter(call => call[0] === 'cancel').length, 1);
  assert.equal(calls.some(call => call[0] === 'end' || call[0] === 'move'), false);
  calls.length = 0;
  canvas.down(event(25, 30)); canvas.move(event(35, 40)); canvas.callbacks.canMove = () => false; canvas.up(event(35, 40));
  assert.equal(calls.filter(call => call[0] === 'cancel').length, 1);
  assert.equal(calls.some(call => call[0] === 'end' || call[0] === 'move'), false);
});

test('选中、连线源和框选只刷新交互状态，不重建图或改变实时帧版本', t => {
  const { canvas, event } = harness(t), world = canvas.world, version = canvas.forceFrameVersion;
  canvas.draw = () => { throw new Error('交互快路径不能重建图'); };
  canvas.down(event(10, 10)); canvas.up(event(10, 10));
  assert.equal(canvas.nodeElements.get('a').classList.contains('selected'), true);
  canvas.updateSelection({ type: 'edge', id: 'bc' });
  assert.equal(canvas.nodeElements.get('a').classList.contains('selected'), false);
  assert.equal(canvas.edgeElements.get('bc').line.classList.contains('selected'), true);
  canvas.setMode('positive'); canvas.pick('a');
  assert.equal(canvas.nodeElements.get('a').classList.contains('link-source'), true);
  canvas.setMode('select');
  assert.equal(canvas.nodeElements.get('a').classList.contains('link-source'), false);
  canvas.down({ ...event(0, 0, null), shiftKey: true }); canvas.move(event(200, 100, null));
  const overlay = canvas.selectionBox;
  assert.equal(overlay.attrs.width, 200);
  canvas.move(event(250, 120, null));
  assert.equal(canvas.selectionBox, overlay);
  canvas.up(event(250, 120, null));
  assert.equal(canvas.selectionBox, null);
  assert.equal(canvas.world, world);
  assert.equal(canvas.forceFrameVersion, version);
});

test('关系符号在全部倍率均不创建，帧更新仍保留节点与连线几何', t => {
  const { canvas, writes } = harness(t);
  canvas.camera.scale = .2; canvas.transform(); writes.length = 0;
  canvas.updateForcePositions({ b: { x: 350, y: 120 } });
  assert.equal(canvas.edgeElements.get('ab').label, undefined);
  assert.equal(writes.some(write => write.element.tag === 'text'), false);
  assert.equal(canvas.root.classList.contains('force-minimal'), true);
  canvas.camera.scale = 1; canvas.transform();
  assert.equal(canvas.edgeElements.get('ab').group.children.some(child => child.tag === 'text'), false);
  assert.deepEqual(canvas.positions.b, { x: 350, y: 120 });
  assert.equal(canvas.root.classList.contains('force-minimal'), false);
});

test('1493 节点和 2702 关系的初绘与连续帧保持索引路径，不执行节点数组搜索', t => {
  const nodes = Array.from({ length: 1493 }, (_, index) => ({ id: `n${index}`, label: `概念 ${index}` }));
  const edges = Array.from({ length: 2702 }, (_, index) => ({ id: `e${index}`, source: `n${index % nodes.length}`,
    target: `n${(index + 1 + Math.floor(index / nodes.length)) % nodes.length}`, relation: 'influence', sign: 1, ruleText: '增加目标' }));
  const positions = Object.fromEntries(nodes.map((node, index) => [node.id, { x: index % 40 * 220, y: Math.floor(index / 40) * 120 }]));
  const started = performance.now(), { canvas, writes } = harness(t, { nodes, edges }, positions), drawn = performance.now();
  const index = canvas.forceAdjacentEdges, elements = canvas.nodeElements;
  canvas.graph.nodes.find = () => { throw new Error('大图帧不能执行 nodes.find'); };
  canvas.graph.nodes.some = () => { throw new Error('大图帧不能执行 nodes.some'); };
  canvas.graph.edges.find = () => { throw new Error('大图帧不能执行 edges.find'); };
  for (let frame = 1; frame <= 20; frame++) {
    for (const point of Object.values(positions)) { point.x += .5; point.y += .25; }
    canvas.updateForcePositions(positions);
  }
  const finished = performance.now();
  assert.equal(canvas.forceAdjacentEdges, index); assert.equal(canvas.nodeElements, elements);
  assert.equal(canvas.nodeElements.size, 1493); assert.equal(canvas.edgeElements.size, 2702);
  assert.ok(writes.length < 20 * (nodes.length + edges.length * 4) / 2, '屏外元素应明显减少 DOM 写入');
  t.diagnostic(`模拟 DOM：初绘 ${(drawn - started).toFixed(1)} ms；20 帧 ${(finished - drawn).toFixed(1)} ms，平均 ${((finished - drawn) / 20).toFixed(1)} ms；共 ${writes.length} 次属性写入`);
  canvas.fit(); writes.length = 0;
  const overviewStarted = performance.now();
  for (let frame = 1; frame <= 10; frame++) {
    for (const point of Object.values(positions)) { point.x += .5; point.y += .25; }
    canvas.updateForcePositions(positions);
  }
  t.diagnostic(`模拟 DOM 全图适应：10 帧平均 ${((performance.now() - overviewStarted) / 10).toFixed(1)} ms，隐藏标签不写坐标`);
});
