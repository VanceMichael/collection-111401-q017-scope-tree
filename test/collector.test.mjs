import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider } from '../provider/server.mjs';
import { openBrowser } from '../src/browser.mjs';
import { collectScope } from '../src/collector.mjs';
import { ScopeDiscrepancyError } from '../src/scope.mjs';
import { Archive } from '../src/archive.mjs';

const TARGET = { storeIds: ['A', 'C'], kind: '直营' };

async function withHarness(run) {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  const browser = await openBrowser();
  try { await run({ provider, directory, browser }); }
  finally { await browser.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
}

// 模拟门店在选择过程中调区：等区域树开始加载子节点后，再让页面看到的目录版本跳变。
// 同一个页面只用一个路由处理器：Playwright 后注册的处理器会拦截先注册的处理器。
async function flipSelectionGeneration(page, { persistent = false } = {}) {
  let treeLoads = 0;
  let flipped = false;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/tree') {
      if (url.searchParams.has('parent')) treeLoads += 1;
      return route.continue();
    }
    if (url.pathname === '/selection') {
      const response = await route.fetch();
      const data = await response.json();
      if (treeLoads > 0 && (!flipped || persistent)) {
        data.generation += 1;
        flipped = true;
      }
      return route.fulfill({ response, json: data });
    }
    return route.continue();
  });
}

test('按直营范围完成选择、核对并交接导出，且不触碰继承勾选与控制面', async () => {
  await withHarness(async ({ provider, directory, browser }) => {
    const result = await collectScope(provider.base, TARGET, directory, { browser });
    assert.deepEqual(result.ids, ['A', 'C']);
    assert.equal(result.generation, 1);
    assert.equal(result.attempts, 1);
    assert.ok(result.receipt.id);
    const archive = new Archive(directory);
    const receipts = await archive.list();
    assert.equal(receipts.length, 1);
    const stored = JSON.parse((await archive.read(receipts[0])).toString('utf8'));
    assert.deepEqual(stored.ids, ['A', 'C']);
    assert.deepEqual(stored.rows.map(row => row.store), ['A', 'C']);

    const audit = provider.audit;
    assert.ok(!audit.some(request => request.path.startsWith('/_control')));
    // 所有写入选择状态的请求都应来自页面交互，收件程序只发起了页面会发起的动作。
    const postSelection = audit.filter(request => request.path === '/selection' && request.method === 'POST');
    assert.ok(postSelection.length >= 3, '应包含清空与两个叶子勾选');
    assert.deepEqual(
      audit.filter(request => request.path === '/export').map(request => request.method),
      ['POST']
    );
  });
});

test('目录第二版下翻页枚举全部门店，加盟店与新增店均不进范围', async () => {
  await withHarness(async ({ provider, directory, browser }) => {
    const control = await fetch(provider.base + '/_control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ generation: 2 })
    });
    assert.equal(control.status, 200);

    const result = await collectScope(provider.base, TARGET, directory, { browser });
    assert.deepEqual(result.ids, ['A', 'C']);
    assert.equal(result.generation, 2);
    // 东区第二版有 4 家门店、每页 2 家，必须真实翻到第二页才能枚举完整。
    const treeQueries = provider.audit
      .filter(request => request.path === '/tree')
      .map(request => request.query);
    assert.ok(treeQueries.includes('?parent=east&page=1'), '未完成懒加载分页');
    // 导出的行数据里不允许出现加盟店 B 与新增店 D。
    assert.deepEqual(result.rows.map(row => row.store).sort(), ['A', 'C']);
  });
});

test('无法确认的门店触发结构化差异并停止，不写入任何收件凭据', async () => {
  await withHarness(async ({ provider, directory, browser }) => {
    await assert.rejects(
      () => collectScope(provider.base, { storeIds: ['A', 'Z'], kind: '直营' }, directory, { browser }),
      error => error instanceof ScopeDiscrepancyError
        && error.details.reason === 'unknown-target'
        && error.details.unknown.includes('Z')
    );
    assert.deepEqual(await new Archive(directory).list(), []);
    assert.ok(!provider.audit.some(request => request.path === '/export'));
  });
});

test('门店类型与指定范围不符时停止，避免误领加盟店', async () => {
  await withHarness(async ({ provider, directory, browser }) => {
    await assert.rejects(
      () => collectScope(provider.base, { storeIds: ['B'], kind: '直营' }, directory, { browser }),
      error => error instanceof ScopeDiscrepancyError
        && error.details.reason === 'kind-mismatch'
        && error.details.wrongKind[0].actual === '加盟'
    );
    assert.deepEqual(await new Archive(directory).list(), []);
  });
});

test('枚举期间目录调版会整页重来，随后按新观察完成领取', async () => {
  await withHarness(async ({ provider, directory, browser }) => {
    // 第一张页面在页面自身的 /selection 往返里只翻转一次版本，模拟枚举途中调区；
    // 重试用的是全新页面，看到的目录恢复一致。
    const flaky = await browser.newPage();
    await flipSelectionGeneration(flaky);
    let opened = 0;
    const fakeBrowser = {
      newPage: () => {
        opened += 1;
        return opened === 1 ? flaky : browser.newPage();
      },
      close: async () => {},
    };
    const result = await collectScope(provider.base, TARGET, directory, { browser: fakeBrowser, maxAttempts: 2 });
    assert.deepEqual(result.ids, ['A', 'C']);
    assert.equal(result.attempts, 2, '第一次观察应因版本漂移作废并整页重来');
    await flaky.close();
  });
});

test('目录持续变化无法确认时，达到重试上限即停止并解释差异', async () => {
  await withHarness(async ({ provider, directory, browser }) => {
    const fakeBrowser = {
      // 每次重试都是新页面，但每一页看到的目录都在枚举途中跳版，模拟持续调区。
      newPage: async () => {
        const flaky = await browser.newPage();
        await flipSelectionGeneration(flaky, { persistent: true });
        return flaky;
      },
      close: async () => {},
    };
    await assert.rejects(
      () => collectScope(provider.base, TARGET, directory, { browser: fakeBrowser, maxAttempts: 2 }),
      error => error instanceof ScopeDiscrepancyError
        && error.message.includes('持续变化')
        && error.details.reason === 'generation-drift'
    );
    assert.deepEqual(await new Archive(directory).list(), []);
  });
});
