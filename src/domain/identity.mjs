const SEMANTIC_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RANDOM_HEX_SEGMENT = /(?:^|-)[0-9a-f]{8}(?:-|$)/;

export function normalizeSearchTerm(value) {
  return String(value).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

export function semanticIdProblem(id) {
  if (typeof id !== 'string' || !SEMANTIC_ID.test(id)) return '必须使用小写英文语义 kebab-case';
  if (RANDOM_HEX_SEGMENT.test(id)) return '不能包含随机十六进制或 UUID 片段';
  return null;
}

export function assertSemanticId(id, location = 'ID') {
  const problem = semanticIdProblem(id);
  if (problem) throw new Error(`${location}${problem}：${String(id)}`);
  return id;
}

export function normalizeAliases(aliases = []) {
  if (!Array.isArray(aliases)) throw new Error('aliases 必须是字符串数组。');
  return aliases.map(value => String(value).trim()).filter(Boolean);
}

export function semanticRuleId(source, target, relationOrUsed = null, maybeUsed = new Set()) {
  assertSemanticId(source, '规则源概念 ID '); assertSemanticId(target, '规则目标概念 ID ');
  // rules v1 的调用方仍以第三参数传 used；rules v2 显式传 relation。
  const legacy = relationOrUsed instanceof Set || relationOrUsed === null || relationOrUsed === undefined;
  const relation = legacy ? null : relationOrUsed;
  const used = relationOrUsed instanceof Set ? relationOrUsed : maybeUsed;
  if (relation !== null && !['influence', 'specializes', 'part-of'].includes(relation)) {
    throw new Error(`未知规则关系：${String(relation)}`);
  }
  const base = relation === null ? `${source}-2-${target}` : `${source}-2-${target}-${relation}`;
  if (!used.has(base)) return base;
  throw new Error(`概念 ${source} 到 ${target} 已有 ${relation ?? "旧协议"} 规则。`);
}
