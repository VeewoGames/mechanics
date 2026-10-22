import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ensureProject } from '../src/server/workspace-commands.mjs';
import { startServer } from '../src/server/http.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-initialization-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('重复初始化修复受管工具与技能，保留损坏的领域原文', async t => {
  const parent = await fixture(t), root = join(parent, 'Wizard');
  await ensureProject(root);
  const tool = join(root, '.mechanics/tools/workspace-tool.mjs');
  const skill = join(root, '.agents/skills/mechanics-search/SKILL.md');
  const manifest = join(root, '.mechanics/workspace.json');
  const originalTool = await readFile(tool, 'utf8'), originalSkill = await readFile(skill, 'utf8');
  await writeFile(manifest, '{损坏的用户数据');
  await writeFile(tool, '损坏的工具'); await writeFile(skill, '损坏的技能');
  assert.equal((await ensureProject(root)).initialized, false);
  assert.equal(await readFile(manifest, 'utf8'), '{损坏的用户数据');
  assert.equal(await readFile(tool, 'utf8'), originalTool);
  assert.equal(await readFile(skill, 'utf8'), originalSkill);
  await rm(tool);
  await ensureProject(root);
  assert.equal(await readFile(tool, 'utf8'), originalTool);
});

test('网页准备空目录自动初始化，可立即读取名称和加载项目，损坏核心仍保留目录', async t => {
  const parent = await fixture(t), root = join(parent, 'Wizard'); await mkdir(root);
  const server = await startServer({ port: 0, projectHistoryPath: join(parent, 'history.json') });
  t.after(() => server.close());
  const post = async path => fetch(server.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectRoot: root }) });
  let response = await post('/api/project/prepare');
  assert.equal(response.status, 200); assert.equal((await response.json()).initialized, true);
  response = await post('/api/project/metadata');
  assert.equal(response.status, 200); assert.equal((await response.json()).name, 'Wizard');
  response = await post('/api/project/open'); assert.equal(response.status, 200);
  await writeFile(join(root, '.mechanics/rules.json'), '{损坏的规则');
  assert.equal((await post('/api/project/prepare')).status, 200);
  assert.equal((await post('/api/project/directory')).status, 200);
  assert.notEqual((await post('/api/project/open')).status, 200);
  assert.equal(await readFile(join(root, '.mechanics/rules.json'), 'utf8'), '{损坏的规则');
});

test('自动加载项目失败或切换目录后迟到响应都不破坏当前目录', async () => {
  const app = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('async function loadPreparedDirectory('), app.indexOf('async function openDirectoryFile('));
  const directory = { projectRoot: '/项目' }, errors = [], activated = [];
  const context = { browserWorkspace: directory, api: async () => { throw new Error('规则损坏'); }, showError: error => errors.push(error.message), activateSourceProject: async value => activated.push(value) };
  const load = runInNewContext(source + '\nloadPreparedDirectory', context);
  await load(directory);
  assert.equal(context.browserWorkspace, directory); assert.match(errors[0], /目录已打开.*规则损坏/);
  context.api = async () => ({ name: '项目' });
  await load(directory); assert.equal(activated.length, 1);
  context.browserWorkspace = { projectRoot: '/其他项目' };
  await load(directory); assert.equal(activated.length, 1);
  context.api = async () => { throw new Error('迟到错误'); };
  await load(directory); assert.equal(errors.length, 1);
});
