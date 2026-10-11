import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkspace } from '../src/domain/validate.mjs';
import { queryWorkspace } from '../src/domain/query.mjs';

const node = id => ({ id, label: id, description: id, agentLocked: false });
const base = rules => ({
  manifest: { schemaVersion: 15, kind: 'workspace', id: 'parts', name: '组成测试', definitions: 'definitions.json', rules: 'rules.json', agentExportPath: 'mechanics', compositions: [] },
  definitions: { schemaVersion: 7, kind: 'definitions', workspaceId: 'parts', tagDefinitions: [], nodes: ['wing', 'bird', 'machine'].map(node), positions: {} },
  rules: { schemaVersion: 2, kind: 'rules', workspaceId: 'parts', rules },
  mechanics: [{ schemaVersion: 9, kind: 'mechanic', workspaceId: 'parts', id: 'core', name: '核心', scope: '直接组成', implementationStatus: 'design', focusNodeIds: ['wing', 'bird', 'machine'], pinnedRuleIds: rules.map(rule => rule.id), ruleSelection: 'explicit', positions: {}, taxonomyPresentation: { mode: 'label', expandedNodeIds: [] } }],
  views: [],
});
const part = (source, target) => ({ id: `${source}-2-${target}-part-of`, source, target, relation: 'part-of' });
const influence = (source, target) => ({ id: `${source}-2-${target}-influence`, source, target, relation: 'influence', sign: 1, inheritance: { mode: 'none' }, ruleText: '直接影响。' });

test('part-of 允许多整体，并与同端点 influence 共存', () => {
  const workspace = base([part('wing', 'bird'), part('wing', 'machine'), influence('wing', 'bird')]);
  validateWorkspace(workspace);
  const queried = queryWorkspace(workspace, { command: 'node', id: 'wing', hops: 1 });
  assert.deepEqual(queried.composition.directWholes.map(item => item.id), ['bird', 'machine']);
  const impact = queryWorkspace(workspace, { command: 'impact', from: 'wing', to: 'bird' });
  assert.equal(impact.paths.length, 1);
  assert.equal(impact.paths[0].kind, 'influence');
});

test('part-of 不进入 impact，也不做传递推导', () => {
  const workspace = base([part('wing', 'bird'), part('bird', 'machine')]);
  validateWorkspace(workspace);
  assert.deepEqual(queryWorkspace(workspace, { command: 'impact', from: 'wing', to: 'machine' }).paths, []);
  const nodeResult = queryWorkspace(workspace, { command: 'node', id: 'wing', hops: 2 });
  assert.deepEqual(nodeResult.composition.directWholes.map(item => item.id), ['bird']);
});

test('part-of 拒绝自连、环和同端点结构冲突', () => {
  assert.throws(() => validateWorkspace(base([part('wing', 'wing')])), { code: 'PART_OF_SELF_LINK' });
  assert.throws(() => validateWorkspace(base([part('wing', 'bird'), part('bird', 'wing')])), { code: 'PART_OF_CYCLE' });
  const specializes = { id: 'wing-2-bird-specializes', source: 'wing', target: 'bird', relation: 'specializes' };
  assert.throws(() => validateWorkspace(base([part('wing', 'bird'), specializes])), { code: 'STRUCTURAL_RELATION_CONFLICT' });
});
