import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTaxonomyPresentation } from '../src/domain/taxonomy-presentation.mjs';

const graph = {
  nodes: [
    { id: 'child', label: '子概念' },
    { id: 'parent', label: '父概念' },
    { id: 'effect', label: '效果' },
  ],
  edges: [
    { id: 'child-is-parent', source: 'child', target: 'parent', relation: 'specializes' },
    { id: 'child-affects-effect', source: 'child', target: 'effect', relation: 'influence', sign: 1 },
  ],
};

test('默认投影用只读标签代替 is-a 边，并隐藏孤立父概念', () => {
  const before = structuredClone(graph);
  const projection = projectTaxonomyPresentation(graph, { retainedNodeIds: ['child'] });
  assert.deepEqual(projection.nodes.map(node => node.id), ['child', 'effect']);
  assert.deepEqual(projection.nodes[0].badges, [{
    kind: 'is-a', text: 'is-a：父概念', sourceId: 'child', targetId: 'parent',
  }]);
  assert.deepEqual(projection.edges.map(edge => edge.id), ['child-affects-effect']);
  assert.deepEqual(graph, before);
});

test('展开当前子概念时恢复其唯一直接父概念和 is-a 边', () => {
  const projection = projectTaxonomyPresentation(graph, { retainedNodeIds: ['child'], expandedNodeIds: ['child'] });
  assert.deepEqual(projection.nodes.map(node => node.id), ['child', 'parent', 'effect']);
  assert.deepEqual(projection.edges.map(edge => edge.id), ['child-is-parent', 'child-affects-effect']);
});

test('part-of 与 is-a 共用展示通道：默认只留 part-of 标签，展开后恢复整体与组成边', () => {
  const composed = structuredClone(graph);
  composed.edges[0] = { id: 'child-part-of-parent', source: 'child', target: 'parent', relation: 'part-of' };
  const collapsed = projectTaxonomyPresentation(composed, { retainedNodeIds: ['child'] });
  assert.deepEqual(collapsed.nodes.map(node => node.id), ['child', 'effect']);
  assert.deepEqual(collapsed.nodes[0].badges, [{
    kind: 'part-of', text: 'part-of：父概念', sourceId: 'child', targetId: 'parent',
  }]);
  assert.deepEqual(collapsed.edges.map(edge => edge.id), ['child-affects-effect']);
  const expanded = projectTaxonomyPresentation(composed, { retainedNodeIds: ['child'], expandedNodeIds: ['child'] });
  assert.deepEqual(expanded.nodes.map(node => node.id), ['child', 'parent', 'effect']);
  assert.deepEqual(expanded.edges.map(edge => edge.id), ['child-part-of-parent', 'child-affects-effect']);
  // 同一概念同时有 is-a 与 part-of 出边不是合法输入，投影入口直接拒绝。
  composed.edges.push({ id: 'child-is-effect', source: 'child', target: 'effect', relation: 'specializes' });
  assert.throws(() => projectTaxonomyPresentation(composed, { retainedNodeIds: ['child'] }), { code: 'STRUCTURAL_MULTIPLE_PARENTS' });
});

test('父概念有非 is-a 可见关系时默认保留', () => {
  const withParentEffect = structuredClone(graph);
  withParentEffect.edges.push({ id: 'parent-affects-effect', source: 'parent', target: 'effect', relation: 'influence', sign: 1 });
  const projection = projectTaxonomyPresentation(withParentEffect, { retainedNodeIds: ['child'] });
  assert.equal(projection.nodes.some(node => node.id === 'parent'), true);
  assert.equal(projection.edges.some(edge => edge.id === 'child-is-parent'), false);
});
