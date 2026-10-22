import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { readProjectMetadata, readWorkspaceDirectory } from '../src/server/workspace.mjs';
import { startServer } from '../src/server/http.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

const app = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
const settingsSource = app.slice(app.indexOf('function applyProjectSettings('), app.indexOf('async function configureProject('));
const metadataSource = app.slice(app.indexOf('async function refreshDirectoryName('), app.indexOf('function activateDirectory('));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-name-'));
  await copyExampleFixture(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('设置保存同步当前项目、源项目、浏览项目和文件标签显示名', () => {
  const old = { projectRoot: '/project', manifest: { name: '旧名' } }, other = { projectRoot: '/other', manifest: { name: '关联项目' } };
  const context = vm.createContext({ workspace: old, sourceProject: old, browserWorkspace: old,
    editorTabs: [{ projectRoot: '/project', projectName: '旧名' }, { projectRoot: '/other', projectName: '关联项目' }], renderSidebar() {}, renderProjectTabs() {}, renderEditorTabs() {} });
  const apply = vm.runInContext(settingsSource + '\napplyProjectSettings', context);
  const next = { projectRoot: '/project', manifest: { name: '新名' } };
  apply(next);
  assert.equal(context.sourceProject, next); assert.equal(context.browserWorkspace, next);
  assert.equal(context.editorTabs[0].projectName, '新名');
  context.sourceProject = other; context.browserWorkspace = other;
  apply(next);
  assert.equal(context.sourceProject, other); assert.equal(context.browserWorkspace, other);
  assert.equal(context.editorTabs[1].projectName, '关联项目');
});

test('目录显示名独立读取并刷新顶栏和项目标签', async () => {
  const opened = { navigationOnly: true, projectRoot: '/project', name: '文件夹名' };
  let renders = 0;
  const context = vm.createContext({ browserWorkspace: opened, api: async () => ({ name: '已保存的新名' }), renderSidebar: () => renders++, renderProjectTabs: () => renders++, showError() { throw new Error('不应报错'); } });
  await vm.runInContext(metadataSource + '\nrefreshDirectoryName', context)(opened);
  assert.equal(opened.name, '已保存的新名'); assert.equal(renders, 2);
});

test('切换后迟到的显示名响应不覆盖新目录或领域会话', async () => {
  for (const fails of [false, true]) {
    const opened = { navigationOnly: true, projectRoot: '/old', name: '旧目录' };
    let resolve, reject;
    const context = vm.createContext({ browserWorkspace: opened, api: () => new Promise((a, b) => { resolve = a; reject = b; }), renderSidebar() { throw new Error('不应绘制'); }, renderProjectTabs() {}, showError() { throw new Error('不应跨项目报错'); } });
    const pending = vm.runInContext(metadataSource + '\nrefreshDirectoryName', context)(opened);
    context.browserWorkspace = { projectRoot: '/new', name: '新项目' };
    if (fails) reject(new Error('旧项目读取失败')); else resolve({ name: '迟到的旧名' });
    await pending;
    assert.equal(context.browserWorkspace.name, '新项目'); assert.equal(opened.name, '旧目录');
  }
});

test('名称加载失败明确提示，但保留目录投影与文件夹名', async () => {
  const opened = { navigationOnly: true, projectRoot: '/project', name: '文件夹名' }, errors = [];
  const context = vm.createContext({ browserWorkspace: opened, api: async () => { throw new Error('坏 JSON'); }, showError: error => errors.push(error) });
  await vm.runInContext(metadataSource + '\nrefreshDirectoryName', context)(opened);
  assert.equal(context.browserWorkspace, opened); assert.equal(opened.name, '文件夹名');
  assert.match(errors[0].message, /目录已打开.*显示名读取失败.*坏 JSON/);
});

test('元信息读取绕过坏规则文件，核心名称损坏时目录仍可打开', async t => {
  const root = await fixture(t), manifestPath = join(root, '.mechanics', 'workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, name: '与文件夹不同的显示名' }));
  await writeFile(join(root, '.mechanics', 'rules.json'), '{坏 JSON');
  assert.equal((await readProjectMetadata(root)).name, '与文件夹不同的显示名');
  await writeFile(manifestPath, '{坏 JSON');
  await assert.rejects(readProjectMetadata(root), { code: 'INVALID_JSON' });
  assert.equal((await readWorkspaceDirectory(root)).navigationOnly, true);
});

test('未初始化目录的名称读取提示初始化，且不会创建工作区', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-name-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(readProjectMetadata(root), {
    code: 'WORKSPACE_NOT_INITIALIZED', message: /尚未初始化.*自动初始化/,
  });
  assert.deepEqual(await readdir(root), []);
  assert.equal((await readWorkspaceDirectory(root)).navigationOnly, true);
});

test('未初始化目录的名称 HTTP 错误保留业务提示且不激活项目', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-name-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = await startServer({ port: 0, projectHistoryPath: join(root, 'history.json') });
  t.after(() => server.close());
  const response = await fetch(server.origin + '/api/project/metadata', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectRoot: root }),
  });
  assert.equal(response.ok, false);
  const body = await response.json();
  assert.equal(body.error, 'WORKSPACE_NOT_INITIALIZED');
  assert.match(body.message, /尚未初始化.*自动初始化/);
  assert.equal((await (await fetch(server.origin + '/api/project')).json()).status, 'empty');
  assert.deepEqual(await readdir(root), []);
});

test('已有工作区缺少清单或名称无效时明确报错，不误判为未初始化', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-name-incomplete-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.mechanics'));
  await assert.rejects(readProjectMetadata(root), {
    code: 'PROJECT_METADATA_MISSING', message: /workspace.json.*缺失.*恢复/,
  });
  for (const name of ['', '   ', null]) {
    await writeFile(join(root, '.mechanics', 'workspace.json'), JSON.stringify({ kind: 'workspace', name }));
    await assert.rejects(readProjectMetadata(root), { code: 'PROJECT_METADATA_INVALID' });
  }
});

test('非目录工作区和不存在的项目不能误判为未初始化', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-name-unsafe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.mechanics'), '不是目录');
  await assert.rejects(readProjectMetadata(root), { code: 'UNSAFE_PATH' });
  await assert.rejects(readProjectMetadata(join(root, 'missing')), { code: 'ENOENT' });
});

test('保存项目设置后独立名称接口每次回读磁盘，刷新不取文件夹名或历史缓存', async t => {
  let server;
  // 先等后台同步与服务关闭，再由 fixture 清理临时目录。
  t.after(() => server?.close());
  const root = await fixture(t);
  server = await startServer({ port: 0, projectHistoryPath: join(root, 'history.json') });
  const post = async (path, data) => {
    const response = await fetch(server.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
  };
  const workspace = await post('/api/project/open', { projectRoot: root });
  await post('/api/project/settings', { projectSessionToken: workspace.projectSessionToken, projectGeneration: workspace.projectGeneration, revision: workspace.revision, name: '改名后项目', agentExportPath: workspace.manifest.agentExportPath });
  assert.equal((await post('/api/project/metadata', { projectRoot: root })).name, '改名后项目');
  const path = join(root, '.mechanics', 'workspace.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...manifest, name: '外部再次改名' }));
  assert.equal((await post('/api/project/metadata', { projectRoot: root })).name, '外部再次改名');
});
