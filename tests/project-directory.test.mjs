import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceDirectory, readWorkspace } from '../src/server/workspace.mjs';
import { copyExampleFixture } from './example-fixture.mjs';
import { startServer } from '../src/server/http.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-directory-'));
  await copyExampleFixture(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('核心 JSON 损坏仍能列出目录，浏览无数据解析、迁移或文件写入', async t => {
  const root = await fixture(t), path = join(root, '.mechanics', 'workspace.json');
  await writeFile(path, '{坏 JSON');
  const directory = await readWorkspaceDirectory(root);
  assert.equal(directory.navigationOnly, true);
  assert.ok(directory.files.some(item => item.path === 'workspace.json'));
  assert.ok(directory.files.some(item => item.path.endsWith('.mechanic.json')));
  assert.equal('definitions' in directory, false);
  assert.equal(await readFile(path, 'utf8'), '{坏 JSON');
  await assert.rejects(readWorkspace(join(root, '.mechanics')), { code: 'INVALID_JSON' });
});

test('不存在工作区时目录仍可打开，并明确报告缺失而不自动初始化', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-empty-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await readWorkspaceDirectory(root);
  assert.equal(directory.diagnostics[0].code, 'ENOENT');
  assert.equal(directory.files.length, 0);
});

test('坏机制 JSON 在读取边界隔离，严格校验仍拒绝', async t => {
  const root = await fixture(t), workspaceRoot = join(root, '.mechanics');
  await mkdir(join(workspaceRoot, 'broken'));
  await writeFile(join(workspaceRoot, 'broken', 'bad.mechanic.json'), '{坏 JSON');
  const workspace = await readWorkspace(workspaceRoot, { isolateResources: true });
  assert.equal(workspace.workspaceState, 'degraded');
  assert.ok(workspace.mechanics.length > 0);
  assert.ok(workspace.resourceDiagnostics.some(item => item.path === 'broken/bad.mechanic.json' && item.code === 'INVALID_JSON'));
  await assert.rejects(readWorkspace(workspaceRoot), { code: 'INVALID_JSON' });
});

test('独立目录 HTTP 接口在核心损坏时返回目录且不激活领域会话', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.mechanics', 'rules.json'), '{坏 JSON');
  const server = await startServer({ port: 0, projectHistoryPath: join(root, 'history.json') });
  t.after(() => server.close());
  const response = await fetch(server.origin + '/api/project/directory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectRoot: root }) });
  assert.equal(response.status, 200);
  const directory = await response.json();
  assert.equal(directory.navigationOnly, true);
  assert.ok(directory.files.some(item => item.path === 'rules.json'));
  assert.equal((await (await fetch(server.origin + '/api/project')).json()).status, 'empty');
});
