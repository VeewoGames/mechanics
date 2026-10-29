import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createOverviewState, composeOverview } from '../src/web/overview.mjs';

const source = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
const apply = source.slice(source.indexOf('async function applyBrowsingWorkspace('), source.indexOf('function activateDirectory('));
const activate = source.slice(source.indexOf('function activateOverview('), source.indexOf('async function openOverview('));
const fixture = () => ({ manifest: { lastView: { viewId: 'missing-view' } }, definitions: { nodes: [{ id: 'a' }], positions: {} }, rules: { rules: [] },
  mechanics: [{ id: 'first', focusNodeIds: ['a'], pinnedRuleIds: [] }], views: [] });

function harness(restoreRecentState = async () => {}) {
  const errors = [], controls = new Map();
  const context = vm.createContext({ workspace: null, activeId: null, graphHistory: null,
    geometryEpoch: 0, screen: 'mechanic', graphReturnScreen: null, draft: undefined, baseline: undefined, history: [], future: [], selection: null, settledRuntime: null,
    cameras: new Map(), implicitPositions: new Map(), sidebarState: { queries: {}, folders: new Set(), lastOpened: null },
    createOverviewState, composeOverview, opened: fixture(),
    $: id => { if (!controls.has(id)) controls.set(id, {}); return controls.get(id); },
    rememberCamera() {}, restoreRecentState, overviewState: () => (context.overview = createOverviewState(context.workspace)),
    finishForceSession() {}, compute: { cancel() {} }, canvas: { cancel() {}, setMode() {}, fit() {} },
    saveFailure: { reset() {} }, render: async () => {}, renderSidebar() {}, renderEditorTabs() {}, renderProjectTabs() {}, refreshReferenceProjects: async () => {}, showError: error => errors.push(error),
  });
  vm.runInContext(activate + '\n' + apply, context);
  return { context, errors };
}

test('打开项目默认进入非文件总览，失效 lastView 不阻断当前机制投影', async () => {
  const { context } = harness();
  await vm.runInContext('applyBrowsingWorkspace(opened, { restoreSourceState: false })', context);
  assert.equal(context.workspace, context.opened);
  assert.equal(context.activeId, null);
  assert.equal(context.sidebarState.page, 'overview');
  assert.equal(context.screen, 'overview');
  assert.equal(context.draft, undefined);
  assert.deepEqual(context.overview.selectedIds, ['first']);
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

test('恢复旧历史时剔除视图记录，即使视图 ID 与有效机制重名也不恢复为机制', async () => {
  const start = source.indexOf('function persistRecentState()'), end = source.indexOf('function resourcePath(', start);
  assert.ok(start >= 0 && end > start);
  const workspace = { projectRoot: 'G:/测试项目', projectSessionToken: 'main', projectGeneration: 1,
    manifest: { name: '主项目' }, mechanics: [{ id: 'first', name: '第一个机制' }],
    views: [{ id: 'first', name: '同名旧视图' }, { id: 'old-view', name: '旧视图' }] };
  const oldState = { lastOpened: { kind: 'view', id: 'first' }, recentViews: ['first', 'old-view'], recentMechanics: ['missing', 'first'],
    openTabs: [{ kind: 'view', id: 'first' }, { kind: 'mechanic', id: 'first' }, { kind: 'mechanic', id: 'missing' }, { kind: 'view', id: 'old-view' }] };
  const saved = [];
  const context = vm.createContext({ workspace, sourceProject: workspace, editorTabs: [], recentStateWrite: Promise.resolve(),
    sidebarState: { recentViews: [], recentMechanics: [], lastOpened: null },
    apiForProject: async () => structuredClone(oldState), api: async (path, body) => saved.push({ path, body: structuredClone(body) }), console });
  vm.runInContext(source.slice(start, end), context);
  await vm.runInContext('restoreRecentState()', context);
  assert.deepEqual(structuredClone(context.editorTabs).map(({ kind, id }) => ({ kind, id })), [{ kind: 'mechanic', id: 'first' }]);
  assert.deepEqual(structuredClone(context.sidebarState.recentMechanics), ['first']);
  assert.equal(context.sidebarState.lastOpened, null);
  assert.deepEqual(structuredClone(context.sidebarState.recentViews ?? []), []);
  await vm.runInContext('persistRecentState(); recentStateWrite', context);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].path, '/api/local-ui-state');
  assert.deepEqual(saved[0].body.openTabs, [{ kind: 'mechanic', id: 'first' }]);
  assert.deepEqual(saved[0].body.recentViews ?? [], []);
  assert.equal(saved[0].body.lastOpened, null);

  oldState.lastOpened = { kind: 'mechanic', id: 'first' };
  await vm.runInContext('restoreRecentState()', context);
  assert.deepEqual(structuredClone(context.sidebarState.lastOpened), { kind: 'mechanic', id: 'first' });
});
