import { composeProjection } from '../domain/graph.mjs';

// 总览是可重建的浏览会话；此模块不接收保存器，不创建视图或工作区文档。
export function createOverviewState(workspace) {
  const ids = workspace.mechanics.map(item => item.id);
  return { knownIds: ids, selectedIds: [...ids], positions: {}, projectionPositions: {},
    taxonomyPresentation: { mode: 'label', expandedNodeIds: [] } };
}

export function reconcileOverviewState(state, workspace) {
  const ids = workspace.mechanics.map(item => item.id), known = new Set(state.knownIds), selected = new Set(state.selectedIds);
  return { ...state, knownIds: ids, selectedIds: ids.filter(id => selected.has(id) || !known.has(id)) };
}

export function selectOverviewMechanics(state, ids) {
  const selected = new Set(ids);
  if ([...selected].some(id => !state.knownIds.includes(id))) throw new Error('总览筛选包含不存在的机制。');
  return { ...state, selectedIds: state.knownIds.filter(id => selected.has(id)) };
}

export function composeOverview(workspace, state) {
  return composeProjection(workspace, { graphIds: state.selectedIds });
}

// 只保留机制明确引用的焦点；由结构边临时带入的父节点仍服从展开状态。
export function overviewRetainedNodeIds(workspace, state) {
  const mechanics = new Map(workspace.mechanics.map(item => [item.id, item]));
  return [...new Set(state.selectedIds.flatMap(id => {
    const mechanic = mechanics.get(id);
    if (!mechanic) throw new Error(`选中的机制图不存在：${id}`);
    return mechanic.focusNodeIds;
  }))];
}

export const forceTopologyKey = graph => JSON.stringify({
  nodes: graph.nodes.map(node => node.id).sort(),
  edges: graph.edges.map(edge => [edge.id, edge.source, edge.target]).sort((a, b) => a[0].localeCompare(b[0])),
});
