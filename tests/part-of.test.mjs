import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkspace } from '../src/domain/validate.mjs';
import { queryWorkspace } from '../src/domain/query.mjs';
import { setStructuralParent } from '../src/domain/graph.mjs';
import { applyAgentMutation } from '../src/server/agent-mutation.mjs';

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

const isa = (source, target) => ({ id: `${source}-2-${target}-specializes`, source, target, relation: 'specializes' });

test('part-of 与同端点 influence 共存，一个局部只属于一个整体', () => {
  const workspace = base([part('wing', 'bird'), influence('wing', 'bird')]);
  validateWorkspace(workspace);
  const queried = queryWorkspace(workspace, { command: 'node', id: 'wing', hops: 1 });
  assert.deepEqual(queried.composition.directWholes.map(item => item.id), ['bird']);
  const impact = queryWorkspace(workspace, { command: 'impact', from: 'wing', to: 'bird' });
  assert.equal(impact.paths.length, 1);
  assert.equal(impact.paths[0].kind, 'influence');
});

test('每个概念至多一个结构父概念：多整体、is-a 与 part-of 并存、混合成环都明确失败', () => {
  assert.throws(() => validateWorkspace(base([part('wing', 'bird'), part('wing', 'machine')])),
    error => error.code === 'STRUCTURAL_MULTIPLE_PARENTS' && error.details.firstRuleId === 'wing-2-bird-part-of' && error.details.secondRuleId === 'wing-2-machine-part-of');
  assert.throws(() => validateWorkspace(base([isa('wing', 'machine'), part('wing', 'bird')])), { code: 'STRUCTURAL_MULTIPLE_PARENTS' });
  assert.throws(() => validateWorkspace(base([isa('wing', 'bird'), part('bird', 'wing')])), { code: 'STRUCTURAL_CYCLE' });
  // 不同概念各自选择一种结构关系是允许的。
  validateWorkspace(base([isa('wing', 'bird'), part('bird', 'machine')]));
});

test('setStructuralParent 在 is-a 与 part-of 间切换时只保留一条结构出边', () => {
  const rules = [part('wing', 'bird'), influence('wing', 'bird')];
  const switched = setStructuralParent(rules, 'wing', 'bird', { relation: 'specializes', schemaVersion: 2 });
  assert.deepEqual(switched.map(rule => rule.id), ['wing-2-bird-influence', 'wing-2-bird-specializes']);
  const moved = setStructuralParent(switched, 'wing', 'machine', { relation: 'part-of', schemaVersion: 2 });
  assert.deepEqual(moved.map(rule => rule.id), ['wing-2-bird-influence', 'wing-2-machine-part-of']);
  assert.deepEqual(moved.at(-1), part('wing', 'machine'));
  assert.equal(setStructuralParent(moved, 'wing', 'machine', { relation: 'part-of', schemaVersion: 2 }), moved, '父概念与关系类型都没变时原样返回');
  assert.deepEqual(setStructuralParent(moved, 'wing', null, { relation: 'part-of', schemaVersion: 2 }).map(rule => rule.id), ['wing-2-bird-influence']);
  assert.throws(() => setStructuralParent(rules, 'wing', 'wing', { relation: 'part-of', schemaVersion: 2 }), { code: 'PART_OF_SELF_LINK' });
  assert.throws(() => setStructuralParent([], 'wing', 'bird', { relation: 'part-of', schemaVersion: 1 }), { code: 'RELATION_REQUIRES_RULES_V2' });
  assert.throws(() => setStructuralParent([], 'wing', 'bird', { relation: 'influence', schemaVersion: 2 }), { code: 'STRUCTURAL_RELATION_INVALID' });
  assert.equal(rules.length, 2, '纯函数不得修改输入');
});

test('Agent rule set-parent 可指定 part-of，并在同一次变更里替换原有 is-a 与固定引用', () => {
  const workspace = { ...base([isa('wing', 'machine')]), resourceRevisions: { rules: 'r1' } };
  const call = fields => applyAgentMutation(workspace, { resource: 'rule', action: 'set-parent', mechanic: 'core', revision: 'r1', ...fields });
  call({ concept: 'wing', parent: 'bird', relation: 'part-of' });
  assert.deepEqual(workspace.rules.rules, [part('wing', 'bird')]);
  assert.deepEqual(workspace.mechanics[0].pinnedRuleIds, ['wing-2-bird-part-of']);
  // 省略 relation 时按 is-a 写入，仍然替换掉原来的 part-of。
  call({ concept: 'wing', parent: 'bird' });
  assert.deepEqual(workspace.rules.rules, [isa('wing', 'bird')]);
  assert.throws(() => call({ concept: 'wing', parent: 'bird', relation: 'influence' }), { code: 'AGENT_MUTATION_INVALID' });
  // 通用 rule add 写入第二条结构出边时由统一校验拒绝。
  assert.throws(() => applyAgentMutation(workspace, { resource: 'rule', action: 'add', mechanic: 'core', revision: 'r1', source: 'wing', target: 'machine', relation: 'part-of' }),
    { code: 'STRUCTURAL_MULTIPLE_PARENTS' });
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
