import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { prepareOpening } from '../src/web/view-files.mjs';

const source = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
const apply = source.slice(source.indexOf('async function applyBrowsingWorkspace('), source.indexOf('function activateDirectory('));
const assign = source.slice(source.indexOf('function assignSnapshot('), source.indexOf('function editView('));
const fixture = () => ({ manifest: { lastView: { viewId: 'missing-view' } }, definitions: { nodes: [], positions: {} }, rules: { rules: [] }, mechanics: [], views: [] });

function harness(restoreRecentState = async () => {}) {
  const errors = [], controls = new Map();
  const context = vm.createContext({ workspace: null, viewId: null, legacy: false, activeId: null, viewRegistrations: [], viewFocusNodeIds: [], viewPinnedRuleIds: [], visible: [], viewPositions: {}, viewNodeColors: {}, viewNodeStyles: {}, scopedPositions: {}, viewRouteCache: null, graphHistory: null,
    cameras: new Map(), implicitPositions: new Map(), sidebarState: { queries: {}, folders: new Set(), lastOpened: null },
    prepareOpening, clone: structuredClone, opened: fixture(),
    $: id => { if (!controls.has(id)) controls.set(id, {}); return controls.get(id); },
    rememberCamera() {}, restoreRecentState, assignLayer: id => { context.activeId = id; },
    autosave: { reset() {} }, render: async () => {}, renderSidebar() {}, renderEditorTabs() {}, renderProjectTabs() {}, refreshReferenceProjects: async () => {}, showError: error => errors.push(error),
  });
  vm.runInContext(assign + '\n' + apply, context);
  return { context, errors };
}

test('打开项目不恢复任何默认或最近图，失效 lastView 不阻断目录', async () => {
  const { context } = harness();
  await vm.runInContext('applyBrowsingWorkspace(opened, { restoreSourceState: false })', context);
  assert.equal(context.workspace, context.opened);
  assert.equal(context.viewId, null); assert.equal(context.activeId, null);
  assert.equal(context.sidebarState.page, 'mechanics');
  assert.deepEqual(JSON.parse(JSON.stringify(context.visible)), []);
});

test('最近记录读取挂起不阻断项目打开', async () => {
  const { context } = harness(() => new Promise(() => {}));
  await vm.runInContext('applyBrowsingWorkspace(opened, { restoreSourceState: true })', context);
  assert.equal(context.workspace, context.opened);
  assert.equal(context.activeId, null);
});

test('最近记录读取失败有用户可见错误，不静默吞掉', async () => {
  const { context, errors } = harness(async () => { throw new Error('坏记录'); });
  await vm.runInContext('applyBrowsingWorkspace(opened, { restoreSourceState: true })', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(errors[0].message, /项目已打开.*最近记录未恢复.*坏记录/);
});
