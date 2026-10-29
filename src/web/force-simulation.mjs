import { assertReadGraphIntegrity } from '../domain/read-graph-integrity.mjs';
import { FORCE_NODE_MAX_RADIUS, forceNodeRadii } from './force-geometry.mjs';

// 节点是圆：两圆圆心至少相距半径和加留白，留白容纳圆下方的名字。坐标仍是锚定框左上角，圆心为固定偏移，碰撞直接用左上角之差。
export const FORCE_COLLISION_GAP = 30;
const CELL = FORCE_NODE_MAX_RADIUS * 2 + FORCE_COLLISION_GAP + 2, CELL_X = CELL, CELL_Y = CELL;
const SEED_X = 112, SEED_Y = 92;
const LINK_DISTANCE = 120, LIMIT = 100000, MAX_SPEED = 40, MAX_VISITS = 420, MAX_COLLISIONS = 48;
// 冷却参照 d3 / MemoryGraph：alpha 每步向目标值靠拢 2.28%，约 240 步才冷却，布局有足够时间解开交叉。
// 斥力强度按本画布的连线长度（约为 MemoryGraph 的 2.2 倍）同比放大；几百个节点以内逐对精确计算。
const ALPHA_DECAY = .0228, ALPHA_MIN = .004, VELOCITY_KEEP = .58, DRAG_ALPHA_TARGET = .3;
const REPEL = 2000, EXACT_REPEL_LIMIT = 420, REPEL_DISTANCE_MAX = 2400, LINK_STRENGTH = .7, CENTER_PULL = .012;
const validPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y)
  && Math.abs(point.x) <= LIMIT && Math.abs(point.y) <= LIMIT;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const pointKey = point => `${point.x}/${point.y}`;
const cellKey = (x, y) => `${x}/${y}`;
const clamp = value => Math.max(-LIMIT, Math.min(LIMIT, value));

function checkedIds(values, byId, label) {
  if (!Array.isArray(values)) fail('FORCE_SIMULATION_INVALID_SELECTION', `${label}必须是节点 ID 数组。`);
  const ids = [...new Set(values)];
  for (const id of ids) if (!byId.has(id)) fail('FORCE_SIMULATION_INVALID_SELECTION', `${label}包含不存在的节点：${String(id)}`);
  return ids;
}

const treeCell = (x, y, size) => ({ x, y, size, count: 0, sumX: 0, sumY: 0, body: -1, children: null });
function childFor(cell, node) {
  const half = cell.size / 2, east = node.x >= cell.x + half, south = node.y >= cell.y + half;
  const index = (south ? 2 : 0) + (east ? 1 : 0);
  return cell.children[index] ??= treeCell(cell.x + (east ? half : 0), cell.y + (south ? half : 0), half);
}
function insert(root, nodes, index) {
  const node = nodes[index]; let cell = root, depth = 0;
  while (true) {
    cell.count++; cell.sumX += node.x; cell.sumY += node.y;
    if (!cell.children) {
      if (cell.body === -1) { cell.body = index; return; }
      // 极密集重合用聚合叶子表示，避免无限细分或叶子内部退化为全量两两遍历。
      if (cell.body === -2 || depth >= 18 || cell.size < .01) { cell.body = -2; return; }
      const oldIndex = cell.body, old = nodes[oldIndex]; cell.body = -1; cell.children = [null, null, null, null];
      const child = childFor(cell, old); child.body = oldIndex; child.count = 1; child.sumX = old.x; child.sumY = old.y;
    }
    cell = childFor(cell, node); depth++;
  }
}
// 斥力大小 ∝ 1/距离（与 d3 manyBody 相同）；近距离下限避免重合时的爆发速度，超出最大距离的远场忽略，
// 让不相连的分量各自成团，而不是被全图斥力推散。
const REPEL_FLOOR = 900, REPEL_DISTANCE_MAX_SQUARED = REPEL_DISTANCE_MAX ** 2;
function repulse(node, dx, dy, squared, mass, alpha, seed) {
  if (squared > REPEL_DISTANCE_MAX_SQUARED) return;
  if (squared < .01) { const angle = (seed + 1) * 2.399963229728653; dx = Math.cos(angle); dy = Math.sin(angle); squared = 1; }
  const weight = REPEL * mass * alpha / Math.max(REPEL_FLOOR, squared);
  node.vx -= dx * weight; node.vy -= dy * weight;
}
function repel(node, index, root, alpha) {
  const stack = [root]; let visited = 0;
  while (stack.length && visited++ < MAX_VISITS) {
    const cell = stack.pop(); if (!cell.count || cell.body === index) continue;
    const inside = node.x >= cell.x && node.x < cell.x + cell.size && node.y >= cell.y && node.y < cell.y + cell.size;
    const count = cell.count - (inside ? 1 : 0); if (count <= 0) continue;
    const dx = (cell.sumX - (inside ? node.x : 0)) / count - node.x;
    const dy = (cell.sumY - (inside ? node.y : 0)) / count - node.y;
    const squared = dx * dx + dy * dy;
    if (cell.children && (inside || cell.size * cell.size > squared * .81) && visited + stack.length < MAX_VISITS - 4) {
      for (const child of cell.children) if (child) stack.push(child);
      continue;
    }
    repulse(node, dx, dy, squared, count, alpha, index);
  }
}

// 首次总览及显式全图重排先按拓扑分组再播种；既有坐标的 start 和拖动不经过此路径。
// 粗层最多 48 个锚点，所有节点的邻接遍历保持线性，不建立全图距离矩阵。
export function initialForcePositions(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) fail('FORCE_SIMULATION_INVALID_INPUT', '初始布局缺少有效显示图。');
  assertReadGraphIntegrity(graph, '实时力导向初始播种');
  const ids = graph.nodes.map(node => node.id).sort(), indexById = new Map(ids.map((id, index) => [id, index]));
  const neighbors = ids.map(() => new Set());
  for (const edge of graph.edges) {
    const a = indexById.get(edge.source), b = indexById.get(edge.target);
    if (a !== b) { neighbors[a].add(b); neighbors[b].add(a); }
  }
  const adjacency = neighbors.map(items => [...items].sort((a, b) => a - b));
  const seen = new Set(), components = [];
  for (let id = 0; id < ids.length; id++) if (!seen.has(id)) {
    const component = [id]; seen.add(id);
    for (let head = 0; head < component.length; head++) for (const neighbor of adjacency[component[head]]) if (!seen.has(neighbor)) {
      seen.add(neighbor); component.push(neighbor);
    }
    components.push(component);
  }
  components.sort((a, b) => b.length - a.length || a[0] - b[0]);
  const local = new Map(), boxes = [];
  for (const component of components) {
    const ranked = [...component].sort((a, b) => adjacency[b].length - adjacency[a].length || a - b);
    const count = Math.min(48, Math.max(1, Math.ceil(component.length / 32)));
    const anchors = ranked.slice(0, count), owner = new Map(anchors.map((id, index) => [id, index]));
    const queue = [...anchors], groups = anchors.map(id => [id]);
    for (let head = 0; head < queue.length; head++) for (const neighbor of adjacency[queue[head]]) if (!owner.has(neighbor)) {
      const group = owner.get(queue[head]); owner.set(neighbor, group); groups[group].push(neighbor); queue.push(neighbor);
    }
    const coarse = groups.map((group, index) => {
      const angle = index * 2.399963229728653, radius = 260 * Math.sqrt(index);
      return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0, radius: 58 * Math.sqrt(group.length) + 50 };
    });
    const pairs = new Map();
    for (const a of component) for (const b of adjacency[a]) if (a < b) {
      const source = owner.get(a), target = owner.get(b); if (source === target) continue;
      const key = source < target ? `${source}/${target}` : `${target}/${source}`;
      const pair = pairs.get(key) ?? { source, target, count: 0 }; pair.count++; pairs.set(key, pair);
    }
    // 有上限的粗层弹簧只决定局部组的相对中心，完整节点物理仍由后续 RAF 推进。
    for (let pass = 0; pass < 72 && coarse.length > 1; pass++) {
      for (const node of coarse) { node.vx -= node.x * .003; node.vy -= node.y * .003; }
      for (const pair of pairs.values()) {
        const a = coarse[pair.source], b = coarse[pair.target], dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
        const strength = Math.max(0, distance - a.radius - b.radius - 60) * .025 * Math.min(3, Math.sqrt(pair.count)) / distance;
        a.vx += dx * strength; a.vy += dy * strength; b.vx -= dx * strength; b.vy -= dy * strength;
      }
      for (let i = 0; i < coarse.length; i++) for (let j = i + 1; j < coarse.length; j++) {
        const a = coarse[i], b = coarse[j], dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
        const strength = Math.max(0, a.radius + b.radius + 60 - distance) * .3 / distance;
        a.vx -= dx * strength; a.vy -= dy * strength; b.vx += dx * strength; b.vy += dy * strength;
      }
      for (const node of coarse) {
        node.vx *= .55; node.vy *= .55; const scale = Math.min(1, 90 / Math.max(1, Math.hypot(node.vx, node.vy)));
        node.x += node.vx * scale; node.y += node.vy * scale;
      }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    groups.forEach((group, groupIndex) => group.forEach((id, order) => {
      const angle = order * 2.399963229728653, radius = Math.sqrt(order), center = coarse[groupIndex];
      const point = { x: center.x + Math.cos(angle) * radius * 66, y: center.y + Math.sin(angle) * radius * 60 };
      local.set(id, point); minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    }));
    boxes.push({ component, minX, minY, width: maxX - minX + SEED_X, height: maxY - minY + SEED_Y });
  }
  const targetWidth = Math.max(1, ...boxes.map(box => box.width), Math.sqrt(boxes.reduce((sum, box) => sum + box.width * box.height, 0)) * 1.25);
  let x = 0, y = 0, rowHeight = 0;
  for (const box of boxes) {
      if (x && x + box.width > targetWidth) { x = 0; y += rowHeight + 120; rowHeight = 0; }
    for (const id of box.component) { const point = local.get(id); point.x += x - box.minX; point.y += y - box.minY; }
    x += box.width + 120; rowHeight = Math.max(rowHeight, box.height);
  }
  // 在拓扑目标附近占用最近空位，首屏就给圆形节点留足间距；搜索次数有界，极端拥挤退到线性空位扫描。
  const occupied = new Set(), offsets = [], positions = new Map();
  for (let oy = -12; oy <= 12; oy++) for (let ox = -8; ox <= 8; ox++) offsets.push({ x: ox, y: oy, distance: (ox * CELL_X) ** 2 + (oy * CELL_Y) ** 2 });
  offsets.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
  const order = ids.map((id, index) => index).sort((a, b) => adjacency[b].length - adjacency[a].length || a - b);
  for (const index of order) {
    const target = local.get(index), cx = Math.round(target.x / CELL_X), cy = Math.round(target.y / CELL_Y);
    let x, y;
    for (const offset of offsets) if (!occupied.has(cellKey(cx + offset.x, cy + offset.y))) { x = cx + offset.x; y = cy + offset.y; break; }
    if (x === undefined) {
      // 极密集时仍围绕所属局部组扩散，不把节点搬到全图底部的公共网格。
      for (let slot = 0; x === undefined; slot++) {
        const ring = Math.ceil((Math.sqrt(slot + 1) - 1) / 2), side = Math.max(1, ring * 2), distance = (ring * 2 + 1) ** 2 - 1 - slot;
        const turn = Math.floor(distance / side), offset = distance % side;
        const ox = turn === 0 ? ring - offset : turn === 1 ? -ring : turn === 2 ? -ring + offset : ring;
        const oy = turn === 0 ? -ring : turn === 1 ? -ring + offset : turn === 2 ? ring : ring - offset;
        if (!occupied.has(cellKey(cx + ox, cy + oy))) { x = cx + ox; y = cy + oy; }
      }
    }
    occupied.add(cellKey(x, y)); positions.set(index, { x: clamp(x * CELL_X), y: clamp(y * CELL_Y) });
  }
  return Object.fromEntries(ids.map((id, index) => [id, positions.get(index)]));
}

// 持续状态模拟：RAF 分片推进弹簧、Barnes–Hut 排斥与按半径的圆形碰撞，不建立全图距离矩阵。
// 输入与输出均为节点锚定框左上角；规则方向、符号和原图不参与修改。
export function createForceSimulation({ onTick = () => {}, onSettle = () => {}, onError = () => {},
  requestFrame = callback => globalThis.requestAnimationFrame(callback),
  cancelFrame = id => globalThis.cancelAnimationFrame(id), now = () => performance.now(),
  frameBudgetMs = 8, maxDurationMs = 9000 } = {}) {
  if (!Number.isFinite(frameBudgetMs) || frameBudgetMs <= 0 || !Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
    fail('FORCE_SIMULATION_INVALID_OPTIONS', '实时布局的帧预算与收敛时限必须是正数。');
  }
  let nodes = [], links = [], byId = new Map(), dragging = new Set(), frame = null, iterator = null;
  let generation = 0, active = false, dirty = false, alpha = 1, alphaTarget = 0, activeElapsedMs = 0, lastActiveFrameAt = null;
  let quietSteps = 0, center = { x: 0, y: 0 }, activeNodes = null;
  let stats = {};
  const fixed = node => node.fixed || dragging.has(node.id);
  const energized = node => activeNodes === null || activeNodes.has(node.id);
  const getPositions = () => Object.fromEntries(nodes.map(node => [node.id, { x: node.x, y: node.y }]));
  const schedule = () => { if (active && frame === null) { const current = generation; frame = requestFrame(() => runFrame(current)); } };
  const releaseDrag = () => { dragging.clear(); for (const node of nodes) { delete node.dragX; delete node.dragY; } };

  function finish(reason) {
    active = false; iterator = null;
    if (frame !== null) cancelFrame(frame); frame = null;
    for (const node of nodes) node.vx = node.vy = 0;
    stats.reason = reason; stats.running = false;
    onSettle({ positions: getPositions() });
  }

  function* step() {
    const stepAlpha = alpha;
    const movable = node => !fixed(node) && energized(node);
    // 弹簧：作用在速度上（d3 forceLink 形式），连接少的一端多动，枢纽稳住；静止长度含两端半径。
    for (let i = 0; i < links.length; i++) {
      const link = links[i], a = nodes[link.source], b = nodes[link.target];
      let dx = b.x + b.vx - a.x - a.vx, dy = b.y + b.vy - a.y - a.vy, length = Math.hypot(dx, dy);
      if (length < .1) { dx = 1; dy = (link.source % 2 ? -1 : 1) * .5; length = Math.hypot(dx, dy); }
      const restLength = LINK_DISTANCE + a.radius + b.radius;
      const k = (length - restLength) / length * stepAlpha * LINK_STRENGTH / Math.min(a.degree, b.degree);
      const bias = a.degree / (a.degree + b.degree), aFixed = !movable(a), bFixed = !movable(b);
      if (!bFixed) { b.vx -= dx * k * (aFixed ? 1 : bias); b.vy -= dy * k * (aFixed ? 1 : bias); }
      if (!aFixed) { a.vx += dx * k * (bFixed ? 1 : 1 - bias); a.vy += dy * k * (bFixed ? 1 : 1 - bias); }
      if (i % 256 === 255) yield;
    }
    if (nodes.length <= EXACT_REPEL_LIMIT) {
      // 中小图逐对精确斥力：远近都按真实距离计算，布局不会因近似而在局部打结。
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i], moveNode = movable(node);
        for (let j = i + 1; j < nodes.length; j++) {
          const other = nodes[j], moveOther = movable(other); if (!moveNode && !moveOther) continue;
          const dx = other.x - node.x, dy = other.y - node.y, squared = dx * dx + dy * dy;
          if (squared > REPEL_DISTANCE_MAX_SQUARED) continue;
          let ux = dx, uy = dy, l2 = squared;
          if (l2 < .01) { const angle = (i * 31 + j * 17) * 2.399963229728653; ux = Math.cos(angle); uy = Math.sin(angle); l2 = 1; }
          const weight = REPEL * stepAlpha / Math.max(REPEL_FLOOR, l2);
          if (moveNode) { node.vx -= ux * weight; node.vy -= uy * weight; }
          if (moveOther) { other.vx += ux * weight; other.vy += uy * weight; }
        }
        if (i % 24 === 23) yield;
      }
    } else {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const node of nodes) { if (node.x < minX) minX = node.x; if (node.y < minY) minY = node.y; if (node.x > maxX) maxX = node.x; if (node.y > maxY) maxY = node.y; }
      const root = treeCell(minX - 1, minY - 1, Math.max(maxX - minX, maxY - minY, 1) + 2);
      for (let i = 0; i < nodes.length; i++) { insert(root, nodes, i); if (i % 256 === 255) yield; }
      for (let i = 0; i < nodes.length; i++) {
        if (movable(nodes[i])) repel(nodes[i], i, root, stepAlpha);
        if (i % 16 === 15) yield;
      }
    }
    // 轻微向心：断开的小分量不会漂远；拖动时只牵动所在分量，不拉动其余部分。
    if (!activeNodes) for (const node of nodes) if (movable(node)) {
      node.vx += (center.x - node.x) * CENTER_PULL * stepAlpha; node.vy += (center.y - node.y) * CENTER_PULL * stepAlpha;
    }
    let maxMotion = 0;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (fixed(node)) { node.vx = node.vy = 0; if (dragging.has(node.id)) { node.x = node.dragX; node.y = node.dragY; } }
      else {
        if (!energized(node)) node.vx = node.vy = 0;
        node.vx *= VELOCITY_KEEP; node.vy *= VELOCITY_KEEP;
        const speed = Math.hypot(node.vx, node.vy), scale = speed > MAX_SPEED ? MAX_SPEED / speed : 1;
        node.vx *= scale; node.vy *= scale;
        node.x = clamp(node.x + node.vx); node.y = clamp(node.y + node.vy);
        maxMotion = Math.max(maxMotion, Math.abs(node.vx), Math.abs(node.vy));
      }
      if (!validPoint(node)) fail('FORCE_SIMULATION_INVALID_POSITION', `实时布局为节点 ${node.id} 产生了无效坐标。`);
      if (i % 64 === 63) { dirty = true; yield; }
    }
    // 碰撞候选使用空间哈希；每节点检查数量有上限，密集桶以迭代轮次轮换候选。
    let collisions = 0;
    for (let sweep = 0; sweep < (stepAlpha ? 2 : 4); sweep++) {
      const cells = new Map();
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i], key = cellKey(Math.floor(node.x / CELL_X), Math.floor(node.y / CELL_Y));
        if (!cells.has(key)) cells.set(key, []); cells.get(key).push(i);
        if (i % 64 === 63) yield;
      }
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i], cx = Math.floor(a.x / CELL_X), cy = Math.floor(a.y / CELL_Y); let checked = 0;
        for (let oy = -1; oy <= 1 && checked < MAX_COLLISIONS; oy++) for (let ox = -1; ox <= 1 && checked < MAX_COLLISIONS; ox++) {
          const bucket = cells.get(cellKey(cx + ox, cy + oy)); if (!bucket) continue;
          const offset = (stats.stepCount * 17 + i * 7) % bucket.length;
          for (let k = 0; k < bucket.length && checked < MAX_COLLISIONS; k++) {
            const j = bucket[(k + offset) % bucket.length]; checked++; if (j <= i) continue;
            const b = nodes[j], aFixed = fixed(a), bFixed = fixed(b); if (aFixed && bFixed) continue;
            if (activeNodes && !activeNodes.has(a.id) && !activeNodes.has(b.id)) continue;
            let dx = b.x - a.x, dy = b.y - a.y; const minimum = a.radius + b.radius + FORCE_COLLISION_GAP;
            const squared = dx * dx + dy * dy; if (squared >= minimum * minimum) continue;
            collisions++;
            let distance = Math.sqrt(squared);
            // 完全重合时按稳定索引给出分离方向，避免除零，也让结果与输入顺序无关。
            if (distance < .01) { const angle = (i * 31 + j * 17) * 2.399963229728653; dx = Math.cos(angle); dy = Math.sin(angle); distance = 1; }
            const push = (minimum - Math.sqrt(squared)) + .01, ux = dx / distance, uy = dy / distance;
            const shareA = aFixed ? 0 : bFixed ? 1 : .5, shareB = bFixed ? 0 : aFixed ? 1 : .5;
            a.x = clamp(a.x - ux * push * shareA); a.y = clamp(a.y - uy * push * shareA);
            b.x = clamp(b.x + ux * push * shareB); b.y = clamp(b.y + uy * push * shareB);
          }
        }
        if (i % 8 === 7) { dirty = true; yield; }
      }
    }
    dirty = true; stats.stepCount++; stats.lastCollisionCount = collisions;
    alpha += (alphaTarget - alpha) * ALPHA_DECAY;
    stats.alpha = alpha;
    quietSteps = maxMotion < .08 && collisions === 0 ? quietSteps + 1 : 0;
    return !dragging.size && (alpha < ALPHA_MIN || quietSteps >= 12);
  }

  function runFrame(current) {
    if (!active || current !== generation) return;
    frame = null; const begin = now(), deadline = begin + frameBudgetMs; let settled = false;
    // 后台标签会暂停 RAF；只累计活跃帧，避免恢复后的第一帧耗尽整个收敛时限。
    activeElapsedMs += lastActiveFrameAt === null ? 16 : Math.max(0, Math.min(40, begin - lastActiveFrameAt));
    lastActiveFrameAt = begin; stats.activeElapsedMs = activeElapsedMs;
    try {
      // 单帧最多推进一个完整物理步；大图超预算时保留生成器游标，下帧继续。
      iterator ??= step();
      let result;
      do { result = iterator.next(); } while (!result.done && now() < deadline);
      if (result.done) { iterator = null; settled = result.value; }
      if (dirty) { dirty = false; onTick({ positions: getPositions() }); }
      if (!active || current !== generation) return;
      const elapsed = now() - begin;
      stats.frameCount++; stats.lastFrameMs = elapsed; stats.maxFrameMs = Math.max(stats.maxFrameMs, elapsed);
      stats.totalFrameMs += elapsed;
      if (settled) finish('converged');
      else if (!dragging.size && activeElapsedMs >= maxDurationMs) finish('time-limit');
      else schedule();
    } catch (error) { api.cancel(); onError(error); }
  }

  const api = {
    start({ graph, positions = {}, selectedIds = [], fixedNodeIds = [] } = {}) {
      if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !positions || typeof positions !== 'object' || Array.isArray(positions)) {
        fail('FORCE_SIMULATION_INVALID_INPUT', '实时布局缺少有效的显示图或坐标。');
      }
      assertReadGraphIntegrity(graph, '实时力导向输入');
      const nextById = new Map(graph.nodes.map((node, index) => [node.id, index]));
      const selected = new Set(checkedIds(selectedIds, nextById, '重排选择')), pinned = new Set(checkedIds(fixedNodeIds, nextById, '固定节点'));
      if (selected.size) for (const id of nextById.keys()) if (!selected.has(id)) pinned.add(id);
      const columns = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length))), groups = new Map(), radii = forceNodeRadii(graph);
      const nextNodes = graph.nodes.map((node, index) => {
        const point = positions[node.id] ?? { x: (index % columns) * (CELL_X + 40), y: Math.floor(index / columns) * (CELL_Y + 40) };
        if (!validPoint(point)) fail('FORCE_SIMULATION_INVALID_POSITION', `节点 ${node.id} 的布局坐标无效。`);
        if (pinned.has(node.id) && !positions[node.id]) fail('FORCE_SIMULATION_INVALID_POSITION', `固定节点 ${node.id} 缺少布局坐标。`);
        const key = pointKey(point); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(index);
        return { id: node.id, x: point.x, y: point.y, vx: 0, vy: 0, degree: 1, radius: radii.get(node.id), fixed: pinned.has(node.id) };
      });
      for (const group of groups.values()) if (group.length > 1) {
        const width = Math.ceil(Math.sqrt(group.length + 1));
        group.forEach((index, order) => {
          const node = nextNodes[index]; if (node.fixed) return;
          const slot = order + 1; node.x = clamp(node.x + (slot % width) * (CELL_X + 20)); node.y = clamp(node.y + Math.floor(slot / width) * (CELL_Y + 20));
        });
      }
      const nextLinks = [], pairs = new Set();
      for (const edge of graph.edges) {
        const source = nextById.get(edge.source), target = nextById.get(edge.target); if (source === target) continue;
        const key = source < target ? `${source}/${target}` : `${target}/${source}`; if (pairs.has(key)) continue;
        pairs.add(key); nextLinks.push({ source, target }); nextNodes[source].degree++; nextNodes[target].degree++;
      }
      api.cancel(); nodes = nextNodes; links = nextLinks; byId = nextById; activeNodes = null;
      center = nodes.reduce((sum, node) => ({ x: sum.x + node.x / Math.max(nodes.length, 1), y: sum.y + node.y / Math.max(nodes.length, 1) }), { x: 0, y: 0 });
      alpha = 1; alphaTarget = 0; quietSteps = 0; activeElapsedMs = 0; lastActiveFrameAt = null; active = true; dirty = true;
      stats = { nodeCount: nodes.length, edgeCount: links.length, frameCount: 0, stepCount: 0, activeElapsedMs: 0, lastFrameMs: 0, maxFrameMs: 0, totalFrameMs: 0, lastCollisionCount: 0, running: true, reason: null };
      if (!nodes.length) { iterator = (function* () { return true; })(); }
      schedule(); return api;
    },
    dragStart(ids) {
      const selected = checkedIds(ids, byId, '拖动选择');
      releaseDrag(); dragging = new Set(selected);
      // 与 MemoryGraph 一致：拖动点固定在指针下（fx/fy），所在连通分量整体保持温热、实时跟随回弹；
      // 不相连的分量已经平衡，不被重新加热。空间碰撞仍作用于全图。
      const adjacency = nodes.map(() => []);
      for (const link of links) { adjacency[link.source].push(link.target); adjacency[link.target].push(link.source); }
      const queue = selected.map(id => byId.get(id)), seen = new Set(queue);
      for (let head = 0; head < queue.length; head++) for (const next of adjacency[queue[head]]) if (!seen.has(next)) { seen.add(next); queue.push(next); }
      activeNodes = new Set(queue.map(index => nodes[index].id));
      for (const id of selected) { const node = nodes[byId.get(id)]; node.dragX = node.x; node.dragY = node.y; node.vx = node.vy = 0; }
      iterator = null; active = true; alphaTarget = DRAG_ALPHA_TARGET; alpha = DRAG_ALPHA_TARGET;
      quietSteps = 0; stats.running = true; stats.reason = null; schedule(); return api;
    },
    drag(ids, positions) {
      const selected = checkedIds(ids, byId, '拖动选择');
      for (const id of selected) {
        if (!dragging.has(id)) fail('FORCE_SIMULATION_DRAG_NOT_STARTED', `节点 ${id} 尚未开始拖动。`);
        if (!validPoint(positions?.[id])) fail('FORCE_SIMULATION_INVALID_POSITION', `节点 ${id} 的拖动坐标无效。`);
      }
      for (const id of selected) { const node = nodes[byId.get(id)], point = positions[id]; node.x = node.dragX = point.x; node.y = node.dragY = point.y; node.vx = node.vy = 0; }
      dirty = true; active = true; alpha = Math.max(alpha, DRAG_ALPHA_TARGET); quietSteps = 0; schedule(); return api;
    },
    // 松手只撤掉固定点和目标温度，alpha 从拖动温度自然冷却，邻居顺势回弹而不是骤停。
    dragEnd() {
      releaseDrag(); activeElapsedMs = 0; lastActiveFrameAt = null; stats.activeElapsedMs = 0;
      alphaTarget = 0; active = true; alpha = Math.max(alpha, DRAG_ALPHA_TARGET * .8); quietSteps = 0; stats.running = true; schedule(); return api;
    },
    stop() { generation++; active = false; iterator = null; if (frame !== null) cancelFrame(frame); frame = null; releaseDrag(); stats.running = false; stats.reason = 'stopped'; return api; },
    cancel() { api.stop(); stats.reason = 'cancelled'; return api; },
    getPositions,
    getStats() { return { ...stats }; },
  };
  return api;
}
