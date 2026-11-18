import test from 'node:test';
import assert from 'node:assert/strict';
import { ScopeDiscrepancyError, diffSets, normalizeTargets, parseLeafLabel, parseScope } from '../src/scope.mjs';

test('parseScope 解析实际门店与目录版本，空集合也可识别', () => {
  assert.deepEqual(parseScope('实际门店：A、C；目录版本：2'), { ids: ['A', 'C'], generation: 2 });
  assert.deepEqual(parseScope('实际门店：；目录版本：1'), { ids: [], generation: 1 });
  assert.deepEqual(parseScope('没有版本'), { ids: [], generation: null });
});

test('diffSets 区分缺少与多出的成员', () => {
  assert.deepEqual(diffSets(['A', 'C'], ['A', 'B']), { missing: ['C'], extra: ['B'] });
  assert.deepEqual(diffSets(['A'], ['A']), { missing: [], extra: [] });
});

test('normalizeTargets 接受文件形态与数组形态并校验空范围', () => {
  assert.deepEqual(normalizeTargets({ storeIds: ['A'], kind: '直营' }), { storeIds: ['A'], kind: '直营' });
  assert.deepEqual(normalizeTargets(['A', 'C']), { storeIds: ['A', 'C'], kind: null });
  assert.throws(() => normalizeTargets({ storeIds: [] }), /门店范围格式无效/);
});

test('parseLeafLabel 提取门店名称与类型', () => {
  assert.deepEqual(parseLeafLabel('二号店（加盟）'), { name: '二号店', kind: '加盟' });
  assert.deepEqual(parseLeafLabel('未标注门店'), { name: '未标注门店', kind: null });
});

test('差异错误携带结构化原因，便于收件程序停止时解释', () => {
  const error = new ScopeDiscrepancyError('缺少门店', { reason: 'unknown-target', unknown: ['Z'] });
  assert.equal(error.name, 'ScopeDiscrepancyError');
  assert.equal(error.details.reason, 'unknown-target');
  assert.deepEqual(error.details.unknown, ['Z']);
});
