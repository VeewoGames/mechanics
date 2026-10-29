import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { hasOnlyPositionChanges } from '../src/web/mechanic-files.mjs';

const saved = { kind: 'mechanic', id: 'first', name: '示例', positions: { a: { x: 0, y: 0 } },
  projectionPositions: { scoped: { x: 100, y: 0 } }, focusNodeIds: ['a'], pinnedRuleIds: [], routeCache: { previous: true } };

test('只有普通或限定投影位置变化才自动保存，规则、引用、样式等内容变化继续确认', () => {
  for (const field of ['positions', 'projectionPositions']) {
    const draft = structuredClone(saved); draft[field][Object.keys(draft[field])[0]].x = 50; delete draft.routeCache;
    assert.equal(hasOnlyPositionChanges(draft, saved), true);
    for (const [field, value] of [['name', '新名称'], ['pinnedRuleIds', ['rule']], ['focusNodeIds', []],
      ['nodeColors', { a: '#D5E8F7' }], ['taxonomyPresentation', { expandedNodeIds: ['a'] }], ['implementationStatus', 'implemented']]) {
      assert.equal(hasOnlyPositionChanges({ ...draft, [field]: value }, saved), false, field);
    }
  }
  assert.equal(hasOnlyPositionChanges(saved, saved), false);
  const cacheOnly = structuredClone(saved); delete cacheOnly.routeCache;
  assert.equal(hasOnlyPositionChanges(cacheOnly, saved), false);
  assert.equal(hasOnlyPositionChanges({ ...saved, kind: 'definitions', positions: {} }, saved), false);
});

const app = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
function harness({ failure = false, contentChange = false, settling = false } = {}) {
  const tab = { id: 'first' }, tabs = [tab], calls = [];
  const draft = structuredClone(saved);
  if (!settling) draft.positions.a.x = 120;
  if (contentChange) draft.name = '内容已修改';
  const context = vm.createContext({ draft, baseline: structuredClone(saved), opening: false, referenceSession: null,
    writeQueue: Promise.resolve(), saveFailure: { blocked: false }, hasOnlyPositionChanges,
    dirty: () => JSON.stringify(context.draft) !== JSON.stringify(context.baseline),
    finishForceSession: () => { if (settling) context.draft.positions.a.x = 120; }, canvas: { cancel() {} },
    saveDraft: async () => { calls.push('save'); if (failure) return false; context.baseline = structuredClone(context.draft); return true; },
    dialog: async () => { calls.push('dialog'); return false; }, showError() {},
    tab, editorTabs: tabs, isActiveEditorTab: () => true, persistTabState() {}, renderEditorTabs() {},
    openOverview: async () => { calls.push('overview'); },
  });
  vm.runInContext(app.slice(app.indexOf('async function guard('), app.indexOf('function activateOverview('))
    + app.slice(app.indexOf('async function closeEditorTab('), app.indexOf('async function returnToSourceProject(')), context);
  return { calls, tabs, context, close: () => vm.runInContext('closeEditorTab(tab)', context) };
}

test('关闭仅位置变化的当前文件直接保存；先提交尚在收敛的位置', async () => {
  for (const settling of [false, true]) {
    const h = harness({ settling }); await h.close();
    assert.deepEqual(h.calls, ['save', 'overview']); assert.equal(h.tabs.length, 0);
    assert.equal(h.context.baseline.positions.a.x, 120);
  }
});

test('保存失败保留文件和位置草稿；含内容变化继续询问', async () => {
  const failed = harness({ failure: true }); await failed.close();
  assert.deepEqual(failed.calls, ['save']); assert.equal(failed.tabs.length, 1);
  assert.notDeepEqual(failed.context.draft, failed.context.baseline);
  const changed = harness({ contentChange: true }); await changed.close();
  assert.deepEqual(changed.calls, ['dialog']); assert.equal(changed.tabs.length, 1);
});
