import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProjectSkills, preflightProjectSkills } from '../src/server/project-skills.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

test('技能目录被 Windows 占用时逐文件原子更新，保留目录并清理过期受管文件', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-skill-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyExampleFixture(root);
  await registerProjectSkills(root);
  const skillRoot = join(root, '.agents', 'skills', 'mechanics-doc');
  await writeFile(join(skillRoot, 'SKILL.md'), '旧版本');
  await writeFile(join(skillRoot, 'obsolete.md'), '过期附件');
  let attempts = 0;
  const result = await registerProjectSkills(root, { renameDirectory: async () => { attempts++; throw Object.assign(new Error('目录已被占用'), { code: 'EPERM' }); } });
  assert.equal(attempts, 1);
  assert.ok(result.installedSkills.includes('.agents/skills/mechanics-doc/SKILL.md'));
  assert.notEqual(await readFile(join(skillRoot, 'SKILL.md'), 'utf8'), '旧版本');
  assert.equal((await readdir(skillRoot)).includes('obsolete.md'), false);
  assert.ok((await preflightProjectSkills(root)).targets.every(item => item.state === 'current'));
});
