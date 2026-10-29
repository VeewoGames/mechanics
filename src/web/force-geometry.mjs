import { assertReadGraphIntegrity } from '../domain/read-graph-integrity.mjs';

// 力导向画布的连线只依赖当前节点位置，不参与正交路由，也不写入路线缓存。
// 坐标仍是 166×62 锚定框的左上角，与正交视图和已存布局兼容；圆形节点画在锚定框中心。
export const FORCE_NODE_SIZE = Object.freeze({ width: 166, height: 62 });
export const FORCE_NODE_MIN_RADIUS = 8, FORCE_NODE_MAX_RADIUS = 44;
// 单个连接数的基准半径（缺少整图信息时的回退）；整图内的实际大小由 forceNodeProfiles 按排名分档。
export const forceNodeRadius = degree => Math.min(34, 9 + Math.sqrt(Math.max(0, degree)) * 4.2);
export const FORCE_DEFAULT_RADIUS = forceNodeRadius(1);
// 节点分三档：普通（多数，小而统一）、次级枢纽（前约 20%）、核心枢纽（前约 5%，至少 1 个）。
// 档位按图内排名决定，图大图小都能拉开层次；还要求连接数明显高于中位数，均匀的小图不硬造枢纽。
export const FORCE_NODE_TIERS = Object.freeze({
  normal: { min: 8, max: 13 }, secondary: { min: 16, max: 24 }, core: { min: 30, max: 44 },
});
export function forceNodeProfiles(graph) {
  const degrees = forceNodeDegrees(graph), entries = [...degrees].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const count = entries.length, sorted = entries.map(([, degree]) => degree).sort((a, b) => a - b);
  const median = count ? sorted[Math.floor((count - 1) / 2)] : 0;
  // 名额按图规模取比例并封顶：核心约前 2%（1–24 个），次级约前 10%（至多 150 个），大图里也保持稀少才显眼。
  const coreSlots = Math.min(24, Math.max(1, Math.round(count * .02))), secondarySlots = Math.min(150, Math.max(coreSlots, Math.round(count * .1)));
  const coreFloor = Math.max(3, median * 3), secondaryFloor = Math.max(2, median * 1.5);
  const tierOf = new Map();
  entries.forEach(([id, degree], rank) => tierOf.set(id,
    rank < coreSlots && degree >= coreFloor ? 'core' : rank < secondarySlots && degree >= secondaryFloor ? 'secondary' : 'normal'));
  // 档内再按连接数平方根细分，同档之间仍有轻微大小差。
  const span = new Map();
  for (const [id, degree] of entries) {
    const tier = tierOf.get(id), range = span.get(tier) ?? { low: Infinity, high: -Infinity };
    range.low = Math.min(range.low, Math.sqrt(degree)); range.high = Math.max(range.high, Math.sqrt(degree)); span.set(tier, range);
  }
  const result = new Map();
  for (const [id, degree] of entries) {
    const tier = tierOf.get(id), { min, max } = FORCE_NODE_TIERS[tier], { low, high } = span.get(tier);
    // 普通档从零起算，孤立点最小；枢纽档在档内从低到高铺开。
    const from = tier === 'normal' ? 0 : low, t = high > from ? (Math.sqrt(degree) - from) / (high - from) : 1;
    result.set(id, { id, degree, tier, radius: min + (max - min) * t });
  }
  return result;
}
// 连接数按关联的非自环关系计；并行关系各算一次，与画面上看到的线条数一致。
export function forceNodeDegrees(graph) {
  const degrees = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue;
    if (degrees.has(edge.source)) degrees.set(edge.source, degrees.get(edge.source) + 1);
    if (degrees.has(edge.target)) degrees.set(edge.target, degrees.get(edge.target) + 1);
  }
  return degrees;
}
export const forceNodeRadii = graph => new Map([...forceNodeProfiles(graph)].map(([id, profile]) => [id, profile.radius]));

const GAP = 4;
const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
export const forceNodeCenter = point => ({ x: point.x + FORCE_NODE_SIZE.width / 2, y: point.y + FORCE_NODE_SIZE.height / 2 });
const format = point => `${Number(point.x.toFixed(3))},${Number(point.y.toFixed(3))}`;
const inside = (point, center, radius) => Math.hypot(point.x - center.x, point.y - center.y) < radius;
const around = (center, angle, distance) => ({ x: center.x + Math.cos(angle) * distance, y: center.y + Math.sin(angle) * distance });

function boundary(center, radius, toward) {
  const dx = toward.x - center.x, dy = toward.y - center.y, length = Math.hypot(dx, dy) || 1;
  return { x: center.x + dx / length * (radius + GAP), y: center.y + dy / length * (radius + GAP) };
}

const quadraticPoint = (a, control, b, t) => ({
  x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * control.x + t ** 2 * b.x,
  y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * control.y + t ** 2 * b.y,
});
const cubicPoint = (a, first, second, b, t) => ({
  x: (1 - t) ** 3 * a.x + 3 * (1 - t) ** 2 * t * first.x + 3 * (1 - t) * t ** 2 * second.x + t ** 3 * b.x,
  y: (1 - t) ** 3 * a.y + 3 * (1 - t) ** 2 * t * first.y + 3 * (1 - t) * t ** 2 * second.y + t ** 3 * b.y,
});

function cubicRoute(start, first, second, end) {
  const label = cubicPoint(start, first, second, end, .5);
  return { path: `M${format(start)} C${format(first)} ${format(second)} ${format(end)}`,
    labelX: label.x, labelY: label.y - 7, start, end, controls: [first, second] };
}

// 两圆贴近或重合（多为拖动瞬间）时，从两圆同一侧的外沿绕出，不画穿过圆心的短线。
function sideRoute(ac, bc, ra, rb, offset, direction) {
  const dx = bc.x - ac.x, dy = bc.y - ac.y, length = Math.hypot(dx, dy);
  const ux = length < 1 ? 1 : dx / length, uy = length < 1 ? 0 : dy / length;
  const side = (offset < 0 ? -1 : 1) * direction, nx = -uy * side, ny = ux * side;
  const height = Math.max(ra, rb) + GAP, reach = 46 + Math.abs(offset);
  const spread = length < 1 ? 14 : 0;
  const start = { x: ac.x + nx * height - ux * spread, y: ac.y + ny * height - uy * spread };
  const end = { x: bc.x + nx * height + ux * spread, y: bc.y + ny * height + uy * spread };
  return cubicRoute(start, { x: start.x + nx * reach, y: start.y + ny * reach }, { x: end.x + nx * reach, y: end.y + ny * reach }, end);
}

export function forceEdgeGeometry(a, b, sourceId, targetId, offset = 0, loopIndex = 0, radii = {}) {
  if (!finitePoint(a) || !finitePoint(b) || !Number.isFinite(offset)) throw new Error('力导向连线缺少有效端点位置。');
  const ra = radii.source ?? FORCE_DEFAULT_RADIUS, rb = radii.target ?? FORCE_DEFAULT_RADIUS;
  const ac = forceNodeCenter(a), bc = forceNodeCenter(b);
  if (sourceId === targetId) {
    // 自环挂在圆的右上方，多个自环逐级外扩。
    const reach = ra + 40 + loopIndex * 22, base = -Math.PI / 4;
    const start = around(ac, base - .5, ra + GAP), end = around(ac, base + .5, ra + GAP);
    return cubicRoute(start, around(ac, base - .85, reach), around(ac, base + .85, reach), end);
  }
  // 使用稳定 ID 的同一法向量，反向边不会因方向翻转而落回同一条曲线。
  const direction = sourceId < targetId ? 1 : -1;
  const dx = bc.x - ac.x, dy = bc.y - ac.y, length = Math.hypot(dx, dy);
  if (length < ra + rb + GAP * 2 + 1) return sideRoute(ac, bc, ra, rb, offset, direction);
  const control = { x: (ac.x + bc.x) / 2 - dy / length * offset * direction,
    y: (ac.y + bc.y) / 2 + dx / length * offset * direction };
  const start = boundary(ac, ra, offset ? control : bc), end = boundary(bc, rb, offset ? control : ac);
  for (let step = 1; step < 32; step++) {
    const point = quadraticPoint(start, control, end, step / 32);
    if (inside(point, ac, ra) || inside(point, bc, rb)) return sideRoute(ac, bc, ra, rb, offset, direction);
  }
  const label = quadraticPoint(start, control, end, .5);
  return { path: offset ? `M${format(start)} Q${format(control)} ${format(end)}` : `M${format(start)} L${format(end)}`,
    labelX: label.x, labelY: label.y - 7, start, end, controls: offset ? [control] : [] };
}

export const FORCE_PARALLEL_SPACING = 30;

const routeSamples = new WeakMap();
// 按弧长记住曲线采样，供锥形轮廓、命中和光点共用；平移、重绘无需重新求曲线。
export function forceRouteSamples(route) {
  if (routeSamples.has(route)) return routeSamples.get(route);
  if (!finitePoint(route?.start) || !finitePoint(route?.end) || !Array.isArray(route.controls)
    || route.controls.length > 2 || !route.controls.every(finitePoint)) throw new Error('锥形连线缺少有效路线。');
  const count = route.controls.length === 2 ? 48 : route.controls.length ? 32 : 1, samples = [];
  let length = 0;
  for (let index = 0; index <= count; index++) {
    const t = index / count, point = route.controls.length === 2 ? cubicPoint(route.start, ...route.controls, route.end, t)
      : route.controls.length ? quadraticPoint(route.start, route.controls[0], route.end, t)
        : { x: route.start.x + (route.end.x - route.start.x) * t, y: route.start.y + (route.end.y - route.start.y) * t };
    if (index) length += Math.hypot(point.x - samples[index - 1].x, point.y - samples[index - 1].y);
    samples.push({ ...point, distance: length });
  }
  for (let index = 0; index < samples.length; index++) {
    const before = samples[Math.max(0, index - 1)], after = samples[Math.min(count, index + 1)];
    const dx = after.x - before.x, dy = after.y - before.y, size = Math.hypot(dx, dy);
    Object.assign(samples[index], { nx: size > 1e-9 ? -dy / size : 0, ny: size > 1e-9 ? dx / size : 1,
      progress: length > 1e-9 ? samples[index].distance / length : index / count });
  }
  const result = { points: samples, length }; routeSamples.set(route, result); return result;
}

export function forceRoutePoint(samples, progress) {
  const points = samples.points, amount = Math.max(0, Math.min(1, progress));
  let low = 0, high = points.length - 1;
  while (low + 1 < high) { const middle = (low + high) >> 1; if (points[middle].progress < amount) low = middle; else high = middle; }
  const first = points[low], second = points[high], t = (amount - first.progress) / (second.progress - first.progress || 1);
  const nx = first.nx + (second.nx - first.nx) * t, ny = first.ny + (second.ny - first.ny) * t, size = Math.hypot(nx, ny) || 1;
  return { x: first.x + (second.x - first.x) * t, y: first.y + (second.y - first.y) * t, nx: nx / size, ny: ny / size, progress: amount };
}

// 宽度以屏幕像素指定。三次曲线分段渐变，确保自环沿路线变浅，而非从相邻的首尾直接拉一条渐变轴。
export function forceEdgeRibbon(route, { startWidth = 6, endWidth = 1.25, scale = 1, dash = [], circles = [] } = {}) {
  if (![startWidth, endWidth, scale].every(value => Number.isFinite(value) && value > 0)
    || dash.length && (dash.length !== 2 || !dash.every(value => Number.isFinite(value) && value > 0))) throw new Error('锥形连线宽度或比例无效。');
  const samples = forceRouteSamples(route), ranges = [], polygons = [];
  if (dash.length && samples.length > 1e-9) {
    const lengthPx = samples.length * scale, period = dash[0] + dash[1];
    for (let start = 0; start < lengthPx; start += period) ranges.push([start / lengthPx, Math.min(1, (start + dash[0]) / lengthPx)]);
  } else {
    const bands = route.controls.length === 2 ? 8 : 1;
    for (let index = 0; index < bands; index++) ranges.push([index / bands, (index + 1) / bands]);
  }
  const outside = point => {
    for (const circle of circles) {
      const dx = point.x - circle.x, dy = point.y - circle.y, size = Math.hypot(dx, dy), radius = circle.radius + .25;
      if (size < radius) { point.x = circle.x + (size ? dx / size : 1) * radius; point.y = circle.y + (size ? dy / size : 0) * radius; }
    }
    return point;
  };
  for (const [from, to] of ranges) {
    const points = [forceRoutePoint(samples, from), ...samples.points.filter(point => point.progress > from && point.progress < to), forceRoutePoint(samples, to)];
    const left = [], right = [];
    for (const point of points) {
      const half = (startWidth + (endWidth - startWidth) * point.progress) / (2 * scale);
      left.push(outside({ x: point.x + point.nx * half, y: point.y + point.ny * half }));
      right.push(outside({ x: point.x - point.nx * half, y: point.y - point.ny * half }));
    }
    polygons.push({ points: [...left, ...right.reverse()], from, to, start: points[0], end: points.at(-1) });
  }
  return { polygons, samples, startWidth, endWidth };
}

export function forceGraphRoutes(graph, positions) {
  assertReadGraphIntegrity(graph, '力导向连线');
  for (const node of graph.nodes) if (!finitePoint(positions[node.id])) throw new Error(`力导向连线缺少有效节点位置：${node.id}`);
  const radii = forceNodeRadii(graph), groups = new Map();
  for (const edge of graph.edges) {
    const key = JSON.stringify([edge.source, edge.target].sort());
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  }
  const result = new Map();
  for (const edges of groups.values()) {
    edges.sort((a, b) => a.id.localeCompare(b.id));
    edges.forEach((edge, index) => result.set(edge.id, forceEdgeGeometry(positions[edge.source], positions[edge.target],
      edge.source, edge.target, (index - (edges.length - 1) / 2) * FORCE_PARALLEL_SPACING, index,
      { source: radii.get(edge.source), target: radii.get(edge.target) })));
  }
  return result;
}
