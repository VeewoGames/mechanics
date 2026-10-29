import test from 'node:test';
import assert from 'node:assert/strict';
import { ConceptDocsPage, mergeDocumentExportResult } from '../src/web/concept-docs.mjs';

test('导出成功以服务端 workspace 快照更新本地 revision 与选择', () => {
  const data = { revision: 'before', selections: [{ kind: 'mechanic', mechanicId: 'old' }] };
  const result = { revision: 'after', manifest: { exportSelections: [{ kind: 'view', viewId: 'current' }] } };
  let received = null;

  const revision = mergeDocumentExportResult(data, result, workspace => { received = workspace; });

  assert.equal(revision, 'after');
  assert.equal(data.revision, 'after');
  assert.deepEqual(data.selections, [{ kind: 'view', viewId: 'current' }]);
  assert.equal(received, result);
});

test('生成成功只推进 revision，不伪造未返回的导出选择', () => {
  const data = { revision: 'before', selections: [{ kind: 'mechanic', mechanicId: 'kept' }] };
  const result = { revision: 'after', manifest: {} };

  mergeDocumentExportResult(data, result);

  assert.equal(data.revision, 'after');
  assert.deepEqual(data.selections, [{ kind: 'mechanic', mechanicId: 'kept' }]);
});

test('网页导出只提供机制和文件夹，旧视图选择仅在明确保存后移除', async () => {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this.value = ''; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
  }
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag) };
  try {
    const data = { revision: 'before', projectSessionToken: 'session', projectGeneration: 1,
      selections: [{ kind: 'mechanic', mechanicId: 'one' }, { kind: 'view', viewId: 'old' }],
      folders: [], mechanics: [{ id: 'one', name: '机制一', folder: '' }], views: [{ id: 'old', name: '旧视图名称' }] };
    const original = structuredClone(data), root = new Element('div'), calls = [];
    const page = new ConceptDocsPage(root, async (path, payload) => {
      calls.push({ path, payload });
      return { revision: 'after', manifest: { exportSelections: payload.selections } };
    }, error => { throw error; });
    page.renderSettings(data, structuredClone(data.selections));
    const flatten = node => [node, ...node.children.flatMap(flatten)];
    const before = flatten(root);
    assert.deepEqual(data, original, '打开设置不修改已保存快照');
    assert.equal(calls.length, 0, '打开设置不发起写入');
    assert.equal(before.some(node => node.textContent === '旧视图名称'), false);
    assert.ok(before.some(node => node.textContent.includes('保存当前设置时，将移除')));
    await before.find(node => node.tagName === 'button' && node.textContent === '保存设置').onclick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/document-export/settings');
    assert.deepEqual(calls[0].payload.selections, [{ kind: 'mechanic', mechanicId: 'one' }]);
    assert.equal(data.revision, 'after');
  } finally { globalThis.document = previousDocument; }
});
