import { assertStructuralRelations, isStructuralRelation } from './graph.mjs';
import { assertReadGraphIntegrity } from './read-graph-integrity.mjs';

// 结构父概念标签：is-a 与 part-of 共用同一展示通道，标签种类与文字前缀即关系类型。
const parentBadge = (edge, name) => {
  const kind = edge.relation === 'part-of' ? 'part-of' : 'is-a';
  return { text: kind + '：' + name(edge.target), kind, sourceId: edge.source, targetId: edge.target };
};

// 结构徽标（基础概念与端点限定）与结构父概念标签同属节点内展示投影；
// 它是规则参与者的只读说明，不是关系本身，因此由 domain 拥有。
export function structuralProjection(graph, mode = 'line') {
  assertReadGraphIntegrity(graph, '结构展示投影输入');
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
  const name = id => nodesById.get(id)?.label ?? id;
  const badgesFor = node => {
    const badges = [];
    // 端点限定投影不是限定概念；它只在节点内展示规则声明的参与者范围。
    if (node.baseConceptId && !node.scopeProjection) badges.push({ text: '基础：' + name(node.baseConceptId), kind: 'base', sourceId: node.id, targetId: node.baseConceptId });
    for (const qualifier of node.qualifiers ?? []) {
      const concept = qualifier.value.kind === 'concept';
      const targetId = concept ? qualifier.value.conceptId : undefined;
      const value = concept ? name(targetId) : String(qualifier.value.value);
      badges.push({ text: qualifier.key + '：' + value, kind: 'qualifier', sourceId: node.id, ...(targetId ? { targetId } : {}) });
    }
    if (mode === 'badge') for (const edge of graph.edges) {
      if (isStructuralRelation(edge.relation) && edge.source === node.id) badges.push(parentBadge(edge, name));
    }
    return badges;
  };
  return assertReadGraphIntegrity({
    nodes: graph.nodes.map(node => ({ ...node, badges: badgesFor(node) })),
    edges: mode === 'badge' ? graph.edges.filter(edge => !isStructuralRelation(edge.relation)) : [...graph.edges],
  }, '结构展示投影输出');
}

// 仅从规范关系派生画布展示；绝不修改输入图或把标签反写为关系。
export function projectTaxonomyPresentation(graph, { expandedNodeIds = [], retainedNodeIds = [] } = {}) {
  assertReadGraphIntegrity(graph, '分类展示投影输入');
  assertStructuralRelations(graph.edges);
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
  const name = id => nodesById.get(id)?.label ?? id;
  // 每个概念至多一个结构父概念，因此 expandedNodeIds 按子概念 ID 即可同时覆盖 is-a 与 part-of。
  const parentByChild = new Map(graph.edges.filter(edge => isStructuralRelation(edge.relation)).map(edge => [edge.source, edge]));
  const expanded = new Set(expandedNodeIds);
  const visibleNodeIds = new Set(retainedNodeIds);
  for (const edge of graph.edges) if (!isStructuralRelation(edge.relation)) {
    visibleNodeIds.add(edge.source);
    visibleNodeIds.add(edge.target);
  }
  for (const childId of expanded) {
    const edge = parentByChild.get(childId);
    if (!edge) continue;
    visibleNodeIds.add(edge.source);
    visibleNodeIds.add(edge.target);
  }
  const nodes = graph.nodes.filter(node => visibleNodeIds.has(node.id)).map(node => {
    const parent = parentByChild.get(node.id);
    return {
      ...structuredClone(node),
      badges: parent ? [parentBadge(parent, name)] : [],
    };
  });
  const edges = graph.edges.filter(edge => !isStructuralRelation(edge.relation)
    ? visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)
    : expanded.has(edge.source) && visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
    .map(edge => structuredClone(edge));
  return assertReadGraphIntegrity({ nodes, edges }, '分类展示投影输出');
}

// 画布、布局与路由的唯一显示投影入口：三者必须消费同一份 displayGraph，
// 否则“隐藏 is-a”只影响渲染，孤立父概念仍会参与排版并占住路线。
export function projectDisplayGraph(graph, { taxonomyPresentation = null, structuralPresentation = 'line', retainedNodeIds = [] } = {}) {
  assertReadGraphIntegrity(graph, '显示投影输入');
  if (!taxonomyPresentation) return structuralProjection(graph, structuralPresentation);
  const projection = projectTaxonomyPresentation(graph, {
    expandedNodeIds: taxonomyPresentation.expandedNodeIds ?? [], retainedNodeIds,
  });
  // 基础与限定徽标不是分类关系，不能被 is-a 标签覆盖；is-a 排在最前，默认即可见。
  const structuralBadges = new Map(structuralProjection(graph, 'line').nodes.map(node => [node.id, node.badges]));
  return assertReadGraphIntegrity({
    nodes: projection.nodes.map(node => ({ ...node,
      badges: [...node.badges, ...(structuralBadges.get(node.id) ?? [])] })),
    edges: projection.edges,
  }, '显示投影输出');
}
