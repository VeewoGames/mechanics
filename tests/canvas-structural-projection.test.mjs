import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphCanvas, badgeDisplayModel, badgeInteractionTargetId, fitText, nodeChipLayout } from '../src/web/canvas.mjs';
import { structuralProjection } from '../src/domain/taxonomy-presentation.mjs';

const canonicalGraph = {
  nodes: [
    { id: 'damage', label: '伤害', description: '基础概念' },
    { id: 'target', label: '目标', description: '基础概念' },
    { id: 'damage-to-target', label: '对目标伤害', description: '限定概念', baseConceptId: 'damage', qualifiers: [
      { key: '目标', value: { kind: 'concept', conceptId: 'target' } },
      { key: '暴击', value: { kind: 'literal', value: true } },
    ] },
  ],
  edges: [
    { id: 'damage-to-target-2-damage', source: 'damage-to-target', target: 'damage', relation: 'specializes' },
    { id: 'damage-2-target', source: 'damage', target: 'target', relation: 'influence', sign: 1 },
  ],
};

const node = (projection, id) => projection.nodes.find(item => item.id === id);

test('结构投影在 line 模式保留全部边，并为限定概念生成基础和 qualifier 徽标', () => {
  const before = structuredClone(canonicalGraph);
  const projection = structuralProjection(canonicalGraph, 'line');

  assert.deepEqual(projection.edges.map(edge => edge.id), ['damage-to-target-2-damage', 'damage-2-target']);
  assert.deepEqual(node(projection, 'damage-to-target').badges, [
    { text: '基础：伤害', kind: 'base', sourceId: 'damage-to-target', targetId: 'damage' },
    { text: '目标：目标', kind: 'qualifier', sourceId: 'damage-to-target', targetId: 'target' },
    { text: '暴击：true', kind: 'qualifier', sourceId: 'damage-to-target' },
  ]);
  assert.deepEqual(canonicalGraph, before);
});

test('结构投影在 badge 模式过滤 specializes，并将出边投影为 is-a 徽标', () => {
  const before = structuredClone(canonicalGraph);
  const projection = structuralProjection(canonicalGraph, 'badge');

  assert.deepEqual(projection.edges.map(edge => edge.id), ['damage-2-target']);
  assert.deepEqual(node(projection, 'damage-to-target').badges.at(-1), {
    text: 'is-a：伤害', kind: 'is-a', sourceId: 'damage-to-target', targetId: 'damage',
  });
  assert.deepEqual(node(projection, 'damage').badges, []);
  assert.deepEqual(canonicalGraph, before);
});

test('端点限定投影只展示参与者限定，不冒充限定概念的基础或 is-a', () => {
  const scoped = { nodes: [{ id: 'scope:health:enemy', label: '气血', description: '气血', scopeProjection: true,
    canonicalNodeId: 'health', baseConceptId: 'health', qualifiers: [{ key: '阵营', value: { kind: 'literal', value: '敌方' } }] }], edges: [] };
  assert.deepEqual(node(structuralProjection(scoped), 'scope:health:enemy').badges, [
    { text: '阵营：敌方', kind: 'qualifier', sourceId: 'scope:health:enemy' },
  ]);
});

test('徽标只为投影中可见的目标提供交互目标', () => {
  const badge = { text: '目标：目标', targetId: 'target' };
  assert.equal(badgeInteractionTargetId(badge, new Set(['damage-to-target', 'target'])), 'target');
  assert.equal(badgeInteractionTargetId(badge, new Set(['damage-to-target'])), null);
  assert.equal(badgeInteractionTargetId({ text: '暴击：true' }, new Set(['damage-to-target'])), null);
});

test('badge 模式优先保留 is-a，并汇总其他来源到完整无障碍文本', () => {
  const badges = node(structuralProjection(canonicalGraph, 'badge'), 'damage-to-target').badges;
  const model = badgeDisplayModel(badges, 'badge');
  assert.equal(model.badges.length, 2);
  assert.equal(model.badges[0].kind, 'is-a');
  assert.equal(model.badges[0].text, 'is-a：伤害');
  assert.equal(model.badges[0].displayText, 'is-a');
  assert.equal(model.badges[0].accessibleText, 'is-a：伤害（概念 ID：damage）');
  assert.deepEqual(model.badges[1], { text: '其余：基础：伤害；目标：目标；暴击：true', kind: 'summary', sourceId: 'damage-to-target', accessibleText: '其余：基础：伤害；目标：目标；暴击：true', displayText: '其余：基础：伤害；目标：目标；暴击：true' });
  assert.match(model.fullText, /基础：伤害（概念 ID：damage）/);
  assert.match(model.fullText, /目标：目标（概念 ID：target）/);
  assert.match(model.fullText, /暴击：true/);
  assert.match(model.fullText, /is-a：伤害（概念 ID：damage）/);
});

test('长 is-a 目标仍显示完整标识，并将完整目标放在自身无障碍文本', () => {
  const longLabel = '这是一个超过固定节点徽标可容纳范围的上位概念名称';
  const model = badgeDisplayModel([{ text: 'is-a：' + longLabel, kind: 'is-a', sourceId: 'child', targetId: 'very-long-parent-id' }, { text: '基础：其他来源', kind: 'base', sourceId: 'child', targetId: 'other' }], 'badge');
  assert.equal(model.badges[0].displayText, 'is-a');
  assert.match(model.badges[0].displayText, /^is-a$/);
  assert.equal(model.badges[0].accessibleText, `is-a：${longLabel}（概念 ID：very-long-parent-id）`);
  assert.match(model.badges[1].accessibleText, /^其余：/);
  assert.doesNotMatch(model.badges[1].accessibleText, /very-long-parent-id/);
});

test('画布与路由请求共享同一显示投影：隐藏的 is-a 父概念不进入命中、几何或 Worker', async () => {
  const canvas = Object.create(GraphCanvas.prototype), requests = [];
  const source = {
    nodes: [{ id: 'child', label: '子概念' }, { id: 'parent', label: '父概念' }, { id: 'effect', label: '效果' }],
    edges: [
      { id: 'child-is-parent', source: 'child', target: 'parent', relation: 'specializes' },
      { id: 'child-affects-effect', source: 'child', target: 'effect', relation: 'influence', sign: 1 },
    ],
  };
  Object.assign(canvas, {
    positions: { child: { x: 0, y: 0 }, parent: { x: 300, y: 0 }, effect: { x: 600, y: 0 } }, mode: 'select',
    draw() {}, transform() {},
    callbacks: { computeGraph: request => { requests.push(request); return Promise.resolve({ routes: [], edgeIds: [], full: false }); } },
  });
  await canvas.update(source, canvas.positions, null, null, false,
    { taxonomyPresentation: { mode: 'label', expandedNodeIds: [] }, retainedNodeIds: ['child'] });
  assert.deepEqual(canvas.graph.nodes.map(node => node.id), ['child', 'effect']);
  assert.deepEqual(canvas.graph.edges.map(edge => edge.id), ['child-affects-effect']);
  assert.deepEqual(requests.map(request => request.payload.graph.nodes.map(node => node.id)), [['child', 'effect']]);
  assert.equal(requests[0].geometryKey.includes('parent'), false, '几何签名不能带着隐藏父概念');
});

test('起点终点只按当前画布这张图的影响连线判定，结构关系与自连接不参与', () => {
  const nodes = ['a', 'b', 'c', 'd', 'parent'].map(id => ({ id, label: id }));
  const edges = [
    { source: 'a', target: 'b', relation: 'influence', steps: [{ ruleId: 'r1' }] },
    { source: 'b', target: 'c', relation: 'influence', steps: [{ ruleId: 'r2' }] },
    { source: 'a', target: 'parent', relation: 'specializes', steps: [{ ruleId: 'r3' }] },
    { source: 'd', target: 'd', relation: 'influence', steps: [{ ruleId: 'r4' }] },
    { source: 'c', target: 'a', relation: 'influence', steps: [{ ruleId: 'r5', graphId: 'other' }] },
  ];
  const roles = activeId => Object.fromEntries(GraphCanvas.prototype.nodeRoles.call({ activeId, graph: { nodes, edges } }));
  // 规则是全局资源，普通连线不带来源图 ID；单张机制图里照样能判定出起点和终点。
  assert.deepEqual(roles('mechanic'), { a: 'node-start', b: '', c: 'node-end', d: '', parent: '' });
  // 视图里所有可见影响连线都算数：c→a 闭合成环后不再有起点和终点。
  assert.deepEqual(roles(null), { a: '', b: '', c: '', d: '', parent: '' });
  assert.deepEqual([...GraphCanvas.prototype.nodeRoles.call({ activeId: null, graph: null })], []);
});

test('节点胶囊始终落在节点内宽里，放不下的标签合并为 +N 并保留完整文字', () => {
  const inner = 166 - 12 * 2;
  const withinBox = layout => [...layout.chips, ...(layout.more ? [layout.more] : [])].every(chip => chip.x >= 0 && chip.x + chip.width <= inner + .001);
  assert.deepEqual(nodeChipLayout([]), { chips: [], more: null });

  const single = nodeChipLayout([{ text: 'is-a：' + '很长的父概念名称'.repeat(4), title: '完整父概念' }]);
  assert.equal(single.chips.length, 1); assert.equal(single.more, null);
  assert.ok(single.chips[0].label.endsWith('…')); assert.ok(withinBox(single));

  const many = nodeChipLayout([{ text: 'is-a：武器' }, ...['资源', '战斗', '成长', '经济', '随机', '核心循环'].map(text => ({ text, title: '标签：' + text }))]);
  assert.equal(many.chips[0].label, 'is-a：武器', '结构标签排在最前且优先完整显示');
  assert.ok(many.more.count > 0); assert.equal(many.chips.length + many.more.count, 7);
  assert.match(many.more.text, /标签：核心循环$/);
  assert.ok(withinBox(many));
  for (const [index, chip] of many.chips.entries()) if (index) assert.ok(chip.x >= many.chips[index - 1].x + many.chips[index - 1].width, '胶囊不重叠');

  assert.equal(fitText('短名', 142, 13), '短名');
  const cut = fitText('一二三四五六七八九十一二三四五', 142, 13);
  assert.ok(cut.endsWith('…') && [...cut].length <= 11);
  assert.ok([...fitText('abcdefghijklmnop', 142, 13)].length === 16, '拉丁文字按实际宽度估算，不再固定截到 10 个字符');
});
