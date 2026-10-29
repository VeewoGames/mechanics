import { compose } from '../domain/graph.mjs';

const fail = message => { throw new Error(message); };

// 自动保存只接受机制坐标变化；派生路线缓存可随坐标一起失效，其余字段必须与基线相同。
export function hasOnlyPositionChanges(current, saved) {
  if (!current || !saved || current.kind !== 'mechanic' || saved.kind !== 'mechanic') return false;
  const content = ({ positions, projectionPositions, routeCache, ...rest }) => rest;
  const positions = value => [value.positions, value.projectionPositions];
  return JSON.stringify(content(current)) === JSON.stringify(content(saved))
    && JSON.stringify(positions(current)) !== JSON.stringify(positions(saved));
}

// 机制自己的位置优先；未记住的节点借用共享初始位置，补位只在页面运行态使用。
export function graphPositions(workspace, graph, positions = {}, mechanicId = null, implicitPositions = {}) {
  const local = workspace.mechanics.find(item => item.id === mechanicId)?.positions ?? {};
  const ids = new Map(graph.nodes.map(node => node.id).sort().map((id, index) => [id, index]));
  const columns = Math.max(4, Math.ceil(Math.sqrt(graph.nodes.length)));
  return Object.fromEntries(graph.nodes.map(node => {
    const index = ids.get(node.id);
    return [node.id, structuredClone(local[node.id] ?? positions[node.id] ?? workspace.definitions.positions[node.id] ?? implicitPositions[node.id]
      ?? { x: (index % columns) * 235 + 40, y: Math.floor(index / columns) * 160 + 40 })];
  }));
}

function openMechanic(workspace, request) {
  if (request?.kind !== 'mechanic') fail('打开请求必须指定 mechanic 类型');
  if (request.id !== null && (typeof request.id !== 'string' || !request.id)) fail('打开机制请求缺少有效文件 ID');
  if (request.id !== null && !workspace.mechanics.some(item => item.id === request.id)) fail('机制文件不存在：' + request.id);
  const graph = compose(workspace, request.id === null ? [] : [request.id]);
  return { workspace, activeId: request.id, original: graph, graph };
}

// 同项目切换复用已验证快照；空机制只重新读取目标文件，打开成功后才替换页面状态。
export async function readOpening(api, request, cachedWorkspace = null, readMechanic = null) {
  const opened = openMechanic(cachedWorkspace ?? await api('/api/workspace'), request);
  if (cachedWorkspace && request.id !== null && opened.graph.nodes.length === 0 && readMechanic) {
    const file = cachedWorkspace.files.find(item => item.kind === 'mechanic' && item.id === request.id)?.path;
    if (!file) fail('目标机制文件不存在：' + request.id);
    const latest = await readMechanic({ id: request.id, file });
    const mechanics = cachedWorkspace.mechanics.map(item => item.id === request.id ? latest.mechanic : item);
    const resourceRevisions = structuredClone(cachedWorkspace.resourceRevisions);
    resourceRevisions.mechanics[request.id] = latest.resourceRevision;
    return openMechanic({ ...cachedWorkspace, mechanics, resourceRevisions }, request);
  }
  return opened;
}
