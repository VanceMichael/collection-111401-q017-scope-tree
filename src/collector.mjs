import { openBrowser } from './browser.mjs';
import { Archive } from './archive.mjs';

/**
 * 门店范围无法确认时抛出：不猜测、不补选，交由人工解释差异。
 */
export class ScopeDiscrepancyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ScopeDiscrepancyError';
    this.details = details;
  }
}

function sameSet(actual, expected) {
  const a = [...actual].map(String).sort();
  const b = [...expected].map(String).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function parseScope(text) {
  const idsPart = text.match(/实际门店：(.*?)；/);
  const generationPart = text.match(/目录版本：(\d+)/);
  const ids = idsPart && idsPart[1].trim()
    ? idsPart[1].split('、').map(value => value.trim()).filter(Boolean)
    : [];
  return { ids: ids.sort(), generation: generationPart ? Number(generationPart[1]) : null };
}

function normalizeRequest(request) {
  if (!request || !Array.isArray(request.storeIds)) {
    throw new ScopeDiscrepancyError('领取请求缺少 storeIds 清单，无法确定门店范围', { request });
  }
  const storeIds = [...new Set(request.storeIds.map(id => String(id).trim()).filter(Boolean))];
  if (!storeIds.length) {
    throw new ScopeDiscrepancyError('领取请求的 storeIds 为空，拒绝空范围领取', { request });
  }
  const kind = request.kind ? String(request.kind) : null;
  return { storeIds, kind };
}

/**
 * 只用页面可见元素走完整个区域树：展开每个区域、翻完每一页，
 * 返回页面上真实存在的门店清单与加载时的目录版本。
 */
async function loadFullTree(page, base) {
  await page.goto(base + '/portal');
  await page.waitForFunction(() => document.querySelector('#scope')?.textContent.includes('目录版本：'));
  const generation = Number(await page.locator('#tree').getAttribute('data-generation'));

  // 服务端选择状态可能保留着上一次（含父级继承）的勾选，先使用页面按钮清空。
  await page.locator('#reset').click();
  await page.waitForFunction(() => {
    const text = document.querySelector('#scope').textContent;
    const match = text.match(/实际门店：(.*?)；/);
    return Boolean(match) && match[1].trim().length === 0;
  });

  const branchCount = await page.locator('[data-branch]').count();
  if (branchCount === 0) {
    throw new ScopeDiscrepancyError('门户树没有任何区域节点，无法核对门店范围', { base });
  }
  for (let index = 0; index < branchCount; index++) {
    const row = page.locator('[data-branch]').nth(index);
    const branchId = await row.getAttribute('data-branch');
    await Promise.all([
      page.waitForResponse(response => response.url().includes(`/tree?parent=${branchId}`)),
      row.locator('button', { hasText: '展开区域' }).click()
    ]);
    // 分页：一直点到该区域不再出现“更多门店”按钮，确保懒加载成员全部进入页面。
    while (await row.locator('button', { hasText: '更多门店' }).count()) {
      await Promise.all([
        page.waitForResponse(response => response.url().includes(`/tree?parent=${branchId}&page=`)),
        row.locator('button', { hasText: '更多门店' }).first().click()
      ]);
    }
  }

  const leaves = await page.locator('label[data-node]').evaluateAll(labels => labels.map(label => {
    const input = label.querySelector('input[data-store]');
    const text = label.textContent.trim();
    const match = text.match(/^(.*?)（([^）]+)）$/);
    return {
      id: input.getAttribute('data-store'),
      name: match ? match[1] : text,
      kind: match ? match[2] : null
    };
  }));
  return { generation, leaves };
}

/**
 * 选门店之前先核对目录：缺节点、类型不符都立即停止，不猜测缺失成员。
 */
function validateInventory(storeIds, kind, leaves, generation) {
  const byId = new Map();
  const reasons = [];
  for (const leaf of leaves) {
    if (byId.has(leaf.id)) reasons.push(`门店 ${leaf.id} 在树中重复出现，身份无法确认`);
    byId.set(leaf.id, leaf);
  }
  const missing = storeIds.filter(id => !byId.has(id));
  if (missing.length) {
    reasons.push(`请求领取的门店在当前目录中找不到：${missing.join('、')}`);
  }
  if (kind) {
    const wrongKind = storeIds
      .filter(id => byId.has(id) && byId.get(id).kind !== kind)
      .map(id => `${id}（页面类型：${byId.get(id).kind}）`);
    if (wrongKind.length) {
      reasons.push(`以下门店不属于请求要求的“${kind}”类型：${wrongKind.join('、')}`);
    }
  }
  if (reasons.length) {
    throw new ScopeDiscrepancyError(`门店范围与门户目录核对不一致，已停止且未导出任何资料：${reasons.join('；')}`, {
      generation,
      expectedStoreIds: storeIds,
      expectedKind: kind,
      observedStores: leaves.map(({ id, name, kind: leafKind }) => ({ id, name, kind: leafKind })),
      reasons
    });
  }
}

/**
 * 一次完整的页面尝试。所有选择状态变更都来自对页面复选框/按钮的真实点击，
 * 不直接调用 /selection、/_control 等接口改写状态。
 * 返回 { retry } 表示检测到目录版本变化，需要整页重开重来。
 */
async function runAttempt(page, base, storeIds, kind) {
  const { generation, leaves } = await loadFullTree(page, base);
  validateInventory(storeIds, kind, leaves, generation);

  // 只逐店勾选叶子，从不触碰父级继承框，避免加盟店或未来新增门店被带入。
  for (const id of storeIds) {
    const checkbox = page.locator(`input[data-store="${id}"]`);
    if (await checkbox.count() !== 1) {
      throw new ScopeDiscrepancyError(`门店 ${id} 在页面上的复选框不唯一，无法安全选择`, { generation, id });
    }
    await checkbox.check();
  }
  await page.waitForFunction(expected => {
    const match = document.querySelector('#scope').textContent.match(/实际门店：(.*?)；/);
    const ids = match && match[1].trim() ? match[1].split('、') : [];
    return ids.length === expected.length && expected.every(id => ids.includes(id));
  }, storeIds.slice().sort());

  const inheritedChecked = await page.locator('input[data-inherit]:checked').count();
  if (inheritedChecked !== 0) {
    throw new ScopeDiscrepancyError('检测到父级继承勾选仍生效，可能包含未授权的加盟或新增门店，已停止', {
      generation, expectedStoreIds: storeIds
    });
  }

  // 以页面“核对范围”展示的服务端实际集合为准，而不是只看复选框外观。
  await page.locator('#check').click();
  const scope = parseScope(await page.locator('#scope').textContent());
  if (scope.generation !== generation) {
    return { retry: true, reason: '目录版本在选择过程中发生变化', observedGeneration: scope.generation, generation };
  }
  if (!sameSet(scope.ids, storeIds)) {
    throw new ScopeDiscrepancyError('页面核对的实际生效门店与请求范围不一致，已停止且未导出', {
      generation, expectedStoreIds: storeIds, effectiveStoreIds: scope.ids
    });
  }

  // 通过页面“领取资料”按钮导出，再校验返回集合确实对应本次范围与版本。
  await page.locator('#export').click();
  await page.waitForFunction(() => document.querySelector('#result').textContent.trim().length > 0);
  let data;
  try {
    data = JSON.parse(await page.locator('#result').textContent());
  } catch (error) {
    throw new ScopeDiscrepancyError(`导出结果无法解析：${error.message}`, { generation });
  }
  if (data.generation !== generation) {
    return { retry: true, reason: '导出时目录版本已变化', observedGeneration: data.generation, generation };
  }
  if (!sameSet(data.ids, storeIds) || !sameSet(data.rows.map(row => row.store), storeIds)) {
    throw new ScopeDiscrepancyError('导出资料对应的门店集合与请求范围不一致，未保存该资料', {
      generation, expectedStoreIds: storeIds, exportIds: data.ids, rowIds: data.rows.map(row => row.store)
    });
  }
  return { retry: false, generation, exportData: data };
}

/**
 * 浏览器领取主流程：
 * 1. 按给定门店范围在门户页面上完成叶子级选择；
 * 2. 展开并翻完整棵树，核对最终生效范围（含类型、缺失成员、父级继承）；
 * 3. 目录在过程中调区（generation 变化）则整页重开重试；
 * 4. 无法确认的成员差异直接抛出 ScopeDiscrepancyError，不猜测、不导出；
 * 5. 导出资料通过现有 Archive 交件并返回收据。
 */
export async function collectScope(base, request, directory, options = {}) {
  const { storeIds, kind } = normalizeRequest(request);
  const maxAttempts = options.maxAttempts ?? 3;
  const onPage = options.onPage ?? null;
  const archive = new Archive(directory);
  const browser = await openBrowser();
  let lastObservedGeneration = null;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const page = await browser.newPage();
      if (onPage) await onPage(page, attempt);
      try {
        const outcome = await runAttempt(page, base, storeIds, kind);
        if (outcome.retry) {
          lastObservedGeneration = outcome.observedGeneration;
          continue;
        }
        const bytes = Buffer.from(JSON.stringify(outcome.exportData));
        const receipt = await archive.save(bytes, {
          url: base + '/export',
          portal: base + '/portal',
          method: 'POST',
          via: 'portal-export-button',
          status: 200,
          type: 'application/json',
          generation: outcome.generation,
          storeIds: storeIds.slice().sort(),
          attempt
        });
        return {
          receipt,
          generation: outcome.generation,
          storeIds: storeIds.slice().sort(),
          attempts: attempt,
          rowCount: outcome.exportData.rows.length
        };
      } finally {
        await page.close();
      }
    }
    throw new ScopeDiscrepancyError(
      `目录在领取过程中连续 ${maxAttempts} 次发生变化，最终生效范围无法稳定确认，已停止且未导出`,
      { expectedStoreIds: storeIds, lastObservedGeneration, attempts: maxAttempts }
    );
  } finally {
    await browser.close();
  }
}
