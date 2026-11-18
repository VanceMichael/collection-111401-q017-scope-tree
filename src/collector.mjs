import { Archive } from './archive.mjs';
import { openBrowser } from './browser.mjs';
import { ScopeDiscrepancyError, diffSets, formatIdList, normalizeTargets, parseLeafLabel, parseScope } from './scope.mjs';

const DEFAULT_ATTEMPTS = 3;
// 本地演练控制面只用于测试编排，领取流程本身绝不允许触碰它。
const FORBIDDEN_PATH = /\/_control(?:\/|$)/;

// 对外入口：给定门户地址、门店范围与收件目录，完成选择、核对与交接。
export async function collectScope(base, target, directory, options = {}) {
  const targets = normalizeTargets(target);
  const maxAttempts = options.maxAttempts ?? DEFAULT_ATTEMPTS;
  const browser = options.browser ?? (await openBrowser());
  const ownsBrowser = !options.browser;
  try {
    return await driveCollection(browser, base, targets, directory, maxAttempts);
  } finally {
    if (ownsBrowser) await browser.close();
  }
}

async function driveCollection(browser, base, targets, directory, maxAttempts) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const page = await browser.newPage();
    try {
      const inspect = guardControlPlane(page);
      await page.goto(base + '/portal', { waitUntil: 'domcontentloaded' });
      await page.locator('[data-branch]').first().waitFor();
      await waitForScopeReady(page);
      const outcome = await runAttempt(page, targets, inspect);
      const bytes = Buffer.from(outcome.exportJson);
      const source = {
        url: base + '/export',
        via: 'portal-browser-selection',
        generation: outcome.generation,
        scope: outcome.ids,
        requested: targets.storeIds,
        collectedAt: new Date().toISOString(),
      };
      const receipt = await new Archive(directory).save(bytes, source);
      return { ...outcome, receipt, attempts: attempt };
    } catch (error) {
      lastError = error;
      // 目录版本漂移属于可恢复差异：整页重来，绝不带着旧观察继续选择。
      const retriable = error instanceof ScopeDiscrepancyError && error.details.reason === 'generation-drift';
      if (!retriable || attempt === maxAttempts) break;
    } finally {
      await page.close().catch(() => {});
    }
  }
  if (lastError instanceof ScopeDiscrepancyError && lastError.details.reason === 'generation-drift') {
    throw new ScopeDiscrepancyError(
      `目录在领取过程中持续变化，重试 ${maxAttempts} 次后仍无法确认最终生效范围，已停止且未导出任何资料。最后差异：${lastError.message}`,
      lastError.details
    );
  }
  throw lastError;
}

// 监听控制面访问；只做记录，在关键节点显式失败，避免事件处理器内抛错丢失上下文。
function guardControlPlane(page) {
  let violated = null;
  page.on('request', request => {
    if (FORBIDDEN_PATH.test(new URL(request.url()).pathname)) violated = request.url();
  });
  return () => {
    if (violated) {
      throw new ScopeDiscrepancyError('领取流程禁止使用控制面修改来源状态：' + violated, { reason: 'forbidden-control-plane' });
    }
  };
}

async function runAttempt(page, targets, inspect) {
  // 先通过页面按钮清空历史选择，避免继承选择把加盟店带入范围。
  await settle(page, () => page.locator('#reset').click(), { expectEmpty: true });
  inspect();

  const observed = await enumerateTree(page);
  inspect();
  verifyRequestedTargets(observed, targets);
  const baseGeneration = observed.generation;

  // 只操作叶子勾选框；继承勾选框（data-inherit）始终不触碰。
  for (const id of targets.storeIds) {
    const box = page.locator(`input[data-store="${id}"]`);
    const after = await settle(page, () => box.check({ force: false }), { include: id });
    assertSameGeneration(after.generation, baseGeneration);
    if (!await box.isChecked()) {
      throw new ScopeDiscrepancyError(`门店 ${id} 的叶子勾选未在页面生效`, { reason: 'leaf-not-checked', id });
    }
  }

  // 以“核对范围”按钮展示的服务端实际集合为准，不相信视觉上的勾选。
  const confirmed = await readAuthoritativeScope(page);
  const selectionDiff = diffSets(targets.storeIds, confirmed.ids);
  if (selectionDiff.missing.length || selectionDiff.extra.length) {
    throw new ScopeDiscrepancyError(
      `页面实际生效范围与指定门店不符：缺少 ${formatIdList(selectionDiff.missing)}，多出 ${formatIdList(selectionDiff.extra)}`,
      { reason: 'scope-mismatch', ...selectionDiff, generation: confirmed.generation }
    );
  }
  await assertInheritBoxesUntouched(page);
  inspect();

  const exportResponse = page.waitForResponse(
    response => new URL(response.url()).pathname === '/export' && response.request().method() === 'POST',
    { timeout: 5000 }
  );
  await page.locator('#export').click();
  await exportResponse;
  await page.waitForFunction(() => document.querySelector('#result').textContent.length > 0, null, { timeout: 5000 });
  const exportText = await page.locator('#result').textContent();

  let payload;
  try { payload = JSON.parse(exportText); }
  catch { throw new ScopeDiscrepancyError('页面返回的领取资料不是有效 JSON，无法交接', { reason: 'invalid-export' }); }

  if (!Array.isArray(payload.ids)) throw new ScopeDiscrepancyError('领取资料缺少门店范围字段', { reason: 'invalid-export' });
  const exportDiff = diffSets(targets.storeIds, payload.ids);
  if (exportDiff.missing.length || exportDiff.extra.length) {
    throw new ScopeDiscrepancyError(
      `领取资料中的门店范围与核对结果不一致：缺少 ${formatIdList(exportDiff.missing)}，多出 ${formatIdList(exportDiff.extra)}`,
      { reason: 'export-mismatch', ...exportDiff }
    );
  }
  if (payload.generation !== confirmed.generation) {
    throw new ScopeDiscrepancyError(
      `目录版本在核对后发生变化（核对时 ${confirmed.generation}，领取时 ${payload.generation}），本次结果不能代表已确认范围`,
      { reason: 'generation-drift', expectedGeneration: confirmed.generation, observedGeneration: payload.generation }
    );
  }
  return { ids: payload.ids, generation: payload.generation, exportJson: exportText, rows: payload.rows ?? [] };
}

// 展开每个区域并翻完所有分页，只依据页面实际渲染的叶子建立名单。
async function enumerateTree(page) {
  const initialGeneration = Number(await page.locator('#tree').getAttribute('data-generation'));
  const branchIds = await page.locator('[data-branch]').evaluateAll(rows => rows.map(row => row.dataset.branch));
  const leaves = new Map();

  for (const branchId of branchIds) {
    await expandBranch(page, branchId);
    const container = page.locator(`[data-children="${branchId}"]`);
    const rows = await container.locator('label[data-node]').evaluateAll(labels => labels.map(label => ({
      id: label.querySelector('input[data-store]')?.dataset.store,
      text: label.textContent ?? '',
    })));
    for (const row of rows) {
      if (!row.id) throw new ScopeDiscrepancyError('页面存在缺少门店标识的叶子节点，无法确认其身份', { reason: 'unidentifiable-leaf' });
      const parsed = parseLeafLabel(row.text);
      if (leaves.has(row.id)) throw new ScopeDiscrepancyError(`门店 ${row.id} 在多个区域出现，无法确认其归属`, { reason: 'duplicate-leaf', id: row.id });
      leaves.set(row.id, { id: row.id, name: parsed.name, kind: parsed.kind, branch: branchId });
    }
  }

  // 枚举过程中目录若已改版，当前观察可能不完整，整轮重来而不是猜测缺失节点。
  const current = await readAuthoritativeScope(page);
  if (current.generation !== initialGeneration) {
    throw new ScopeDiscrepancyError(
      `枚举期间目录版本从 ${initialGeneration} 变为 ${current.generation}，已加载门店可能不再完整`,
      { reason: 'generation-drift', expectedGeneration: initialGeneration, observedGeneration: current.generation }
    );
  }
  return { leaves, generation: initialGeneration, branches: branchIds };
}

// 展开区域并翻完分页。按钮在请求发出前就会禁用，因此以页面自身的 /tree 往返与
// DOM 增长为准，而不是只看按钮状态；全程只点击页面控件，不直接请求数据接口。
async function expandBranch(page, branchId) {
  const branch = page.locator(`[data-branch="${branchId}"]`);
  const treeResponse = parent => page.waitForResponse(
    response => {
      const url = new URL(response.url());
      return url.pathname === '/tree' && url.searchParams.get('parent') === parent;
    },
    { timeout: 5000 }
  );
  const waitGrowth = async (count) => page.waitForFunction(
    ([id, previous]) => document.querySelectorAll(`[data-children="${id}"] label[data-node]`).length > previous,
    [branchId, count],
    { timeout: 5000 }
  );

  let pending = treeResponse(branchId);
  await branch.locator('button').click();
  await pending;
  if (await page.locator(`[data-children="${branchId}"] label[data-node]`).count() > 0) {
    await waitGrowth(0);
  }

  const container = page.locator(`[data-children="${branchId}"]`);
  // 懒加载分页：持续点击“更多门店”，直到页面不再出现该按钮。
  while (await container.locator('button', { hasText: '更多门店' }).count()) {
    const before = await container.locator('label[data-node]').count();
    pending = treeResponse(branchId);
    await container.locator('button', { hasText: '更多门店' }).click();
    await pending;
    await waitGrowth(before);
  }
}

function verifyRequestedTargets(observed, targets) {
  const unknown = [];
  const wrongKind = [];
  for (const id of targets.storeIds) {
    const leaf = observed.leaves.get(id);
    if (!leaf) { unknown.push(id); continue; }
    if (targets.kind && leaf.kind && leaf.kind !== targets.kind) {
      wrongKind.push({ id, expected: targets.kind, actual: leaf.kind, name: leaf.name });
    }
  }
  if (unknown.length) {
    throw new ScopeDiscrepancyError(
      `指定门店 ${formatIdList(unknown)} 在当前目录中无法确认，已展开全部区域与分页仍未找到；不猜测缺失节点，停止领取`,
      { reason: 'unknown-target', unknown, observedGeneration: observed.generation, observedLeaves: [...observed.leaves.keys()] }
    );
  }
  if (wrongKind.length) {
    throw new ScopeDiscrepancyError(
      `门店类型与指定范围不符：${wrongKind.map(item => `${item.id}（应为${item.expected}，实际${item.actual}）`).join('、')}`,
      { reason: 'kind-mismatch', wrongKind }
    );
  }
}

async function readAuthoritativeScope(page) {
  return settle(page, () => page.locator('#check').click(), {});
}

function assertSameGeneration(observed, expected) {
  if (observed !== expected) {
    throw new ScopeDiscrepancyError(
      `目录版本在选择过程中从 ${expected} 变为 ${observed}，当前勾选可能已不代表原目录成员`,
      { reason: 'generation-drift', expectedGeneration: expected, observedGeneration: observed }
    );
  }
}

// 页面每次操作都会请求自身的 /selection 数据服务；等待其 GET 往返完成再读取 #scope 文案。
// 这里只观察页面自身发出的请求是否完成，不直接调用任何接口修改选择状态。
async function settle(page, action, { expectEmpty = false, include = null } = {}) {
  const response = page.waitForResponse(
    candidate => new URL(candidate.url()).pathname === '/selection' && candidate.request().method() === 'GET',
    { timeout: 5000 }
  );
  await action();
  await response;
  await page.waitForFunction(option => {
    const text = document.querySelector('#scope').textContent ?? '';
    if (!/目录版本：\d+/.test(text)) return false;
    const ids = (text.match(/实际门店：([^；;]*)/)?.[1] ?? '').split('、').map(value => value.trim()).filter(Boolean);
    if (option.expectEmpty) return ids.length === 0;
    if (option.include) return ids.includes(option.include);
    return true;
  }, { expectEmpty, include }, { timeout: 5000 });
  const parsed = parseScope(await page.locator('#scope').textContent());
  if (parsed.generation === null) {
    throw new ScopeDiscrepancyError('页面未展示目录版本，无法确认生效范围', { reason: 'missing-generation' });
  }
  return parsed;
}

async function waitForScopeReady(page) {
  await page.waitForFunction(() => /目录版本：\d+/.test(document.querySelector('#scope')?.textContent ?? ''), null, { timeout: 5000 });
}

async function assertInheritBoxesUntouched(page) {
  const checked = await page.locator('input[data-inherit]:checked').count();
  if (checked !== 0) {
    throw new ScopeDiscrepancyError('检测到区域继承勾选被选中，可能把加盟或未来新增门店纳入范围', { reason: 'inherit-selected' });
  }
}
