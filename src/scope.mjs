// 范围核对的纯函数与差异类型：不访问网络、不操作页面，便于单测与程序化诊断。

export class ScopeDiscrepancyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ScopeDiscrepancyError';
    this.details = details;
  }
}

// 页面 #scope 文案形如：实际门店：A、C；目录版本：2
// 空集合时为：实际门店：；目录版本：1
export function parseScope(text) {
  const source = String(text ?? '');
  const idPart = source.match(/实际门店：([^；;]*)/);
  const generationPart = source.match(/目录版本：(\d+)/);
  const ids = (idPart?.[1] ?? '')
    .split('、')
    .map(value => value.trim())
    .filter(Boolean);
  const generation = generationPart ? Number(generationPart[1]) : null;
  return { ids, generation };
}

export function diffSets(expected, actual) {
  const wanted = new Set(expected);
  const seen = new Set(actual);
  return {
    missing: expected.filter(id => !seen.has(id)),
    extra: actual.filter(id => !wanted.has(id)),
  };
}

// 接受 fixtures/request.json 形态 {storeIds, kind}，也接受简单 id 数组。
export function normalizeTargets(input) {
  if (Array.isArray(input)) return { storeIds: [...input], kind: null };
  if (!input || !Array.isArray(input.storeIds) || input.storeIds.length === 0) {
    throw new Error('门店范围格式无效：需要非空的 storeIds 列表');
  }
  return { storeIds: [...input.storeIds], kind: input.kind ?? null };
}

// 叶子文案形如：二号店（加盟）
export function parseLeafLabel(text) {
  const matched = String(text ?? '').trim().match(/^(.*?)（([^）]+)）\s*$/);
  if (!matched) return { name: String(text ?? '').trim(), kind: null };
  return { name: matched[1].trim(), kind: matched[2].trim() };
}

export function formatIdList(ids) {
  return ids.length ? ids.join('、') : '（空）';
}
