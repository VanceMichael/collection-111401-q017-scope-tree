import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider } from '../provider/server.mjs';
import { collectScope, ScopeDiscrepancyError } from '../src/collector.mjs';
import { openBrowser } from '../src/browser.mjs';
import { Archive } from '../src/archive.mjs';

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-test-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function controlled(provider, change) {
  const response = await fetch(provider.base + '/_control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change)
  });
  assert.equal(response.status, 200);
}

function selectionMutations(provider) {
  return provider.audit.filter(item => item.path === '/selection' && item.method === 'POST');
}

test('按直营门店范围完成纯页面选择并把导出资料交入收件库', { timeout: 30000 }, async () => {
  const provider = await createProvider();
  await withDirectory(async directory => {
    try {
      const result = await collectScope(provider.base, { storeIds: ['A', 'C'], kind: '直营' }, directory);
      assert.deepEqual(result.storeIds, ['A', 'C']);
      assert.equal(result.generation, 1);
      assert.equal(result.attempts, 1);
      assert.equal(result.rowCount, 2);

      const archive = new Archive(directory);
      const receipts = await archive.list();
      assert.equal(receipts.length, 1);
      const bytes = await archive.read(receipts[0]);
      const payload = JSON.parse(bytes.toString('utf8'));
      assert.deepEqual(payload.ids.sort(), ['A', 'C']);
      assert.equal(payload.generation, 1);
      assert.deepEqual(payload.rows.map(row => row.store).sort(), ['A', 'C']);
      assert.equal(receipts[0].source.via, 'portal-export-button');

      // 所有选择状态变更都来自页面复选框触发的业务请求，控制面从未被业务流程触碰。
      assert.ok(selectionMutations(provider).length > 0);
      assert.ok(!provider.audit.some(item => item.path === '/_control'));
      // 未使用页面外的直接导出：唯一 /export 来自浏览器内按钮点击。
      assert.ok(provider.audit.some(item => item.path === '/export'));
    } finally { await provider.close(); }
  });
});

test('翻完懒加载分页后才能选到第二页的门店', { timeout: 30000 }, async () => {
  const provider = await createProvider();
  await controlled(provider, { generation: 2 }); // 东区变为 A、B、C、D，每页两条，需要点“更多门店”
  await withDirectory(async directory => {
    try {
      const result = await collectScope(provider.base, { storeIds: ['A', 'C', 'D'], kind: '直营' }, directory);
      assert.equal(result.generation, 2);
      assert.deepEqual(result.storeIds, ['A', 'C', 'D']);
      const payload = JSON.parse((await new Archive(directory).read(result.receipt)).toString('utf8'));
      assert.deepEqual(payload.ids.sort(), ['A', 'C', 'D']);
      // 东区加载了两页，审计里应出现 page=1 的分页请求。
      assert.ok(provider.audit.some(item => item.path === '/tree' && item.query.includes('page=1')));
    } finally { await provider.close(); }
  });
});

test('选择过程中发生调区会整页重开并在新版本上核对成功', { timeout: 45000 }, async () => {
  const provider = await createProvider();
  await withDirectory(async directory => {
    try {
      // 只观察页面发出的业务请求：在页面点击“核对范围”的瞬间切换目录版本，
      // 模拟门店在选择中调区（C 从西区调到东区并新增 D）。只翻转一次。
      let flipped = false;
      const onPage = page => {
        let selectionGets = 0;
        page.on('request', request => {
          if (request.url().endsWith('/selection') && request.method() === 'GET') {
            selectionGets += 1;
            // 每次尝试内 GET 次序：初始化 1、清空 1、两个叶子勾选 2，第 5 次即“核对范围”。
            if (selectionGets === 5 && !flipped) {
              flipped = true;
              fetch(provider.base + '/_control', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ generation: 2 })
              }).catch(() => {});
            }
          }
        });
      };
      const result = await collectScope(
        provider.base, { storeIds: ['A', 'C'], kind: '直营' }, directory, { onPage }
      );
      assert.equal(result.generation, 2);
      assert.equal(result.attempts, 2);
      assert.deepEqual(result.storeIds, ['A', 'C']);
      const payload = JSON.parse((await new Archive(directory).read(result.receipt)).toString('utf8'));
      assert.deepEqual(payload.ids.sort(), ['A', 'C']);
      // 调区后仍只领取叶子 A、C，父级继承没有把新增的 D 或加盟 B 带进来。
      assert.ok(!payload.ids.includes('B'));
      assert.ok(!payload.ids.includes('D'));
    } finally { await provider.close(); }
  });
});

test('目录中找不到请求门店时停止并解释差异，不导出任何资料', { timeout: 30000 }, async () => {
  const provider = await createProvider();
  await withDirectory(async directory => {
    try {
      await assert.rejects(
        collectScope(provider.base, { storeIds: ['A', 'Z'], kind: '直营' }, directory),
        error => {
          assert.ok(error instanceof ScopeDiscrepancyError);
          assert.match(error.message, /找不到/);
          assert.deepEqual(error.details.expectedStoreIds, ['A', 'Z']);
          assert.ok(error.details.observedStores.some(store => store.id === 'A'));
          assert.ok(error.details.reasons.some(reason => reason.includes('Z')));
          return true;
        }
      );
      assert.deepEqual(await new Archive(directory).list(), []);
      assert.ok(!provider.audit.some(item => item.path === '/export'));
    } finally { await provider.close(); }
  });
});

test('请求门店类型与页面标注不符（误选加盟店）时停止', { timeout: 30000 }, async () => {
  const provider = await createProvider();
  await withDirectory(async directory => {
    try {
      await assert.rejects(
        collectScope(provider.base, { storeIds: ['A', 'B'], kind: '直营' }, directory),
        error => {
          assert.ok(error instanceof ScopeDiscrepancyError);
          assert.match(error.message, /核对不一致/);
          assert.ok(error.details.reasons.some(reason => reason.includes('B') && reason.includes('加盟')));
          return true;
        }
      );
      assert.deepEqual(await new Archive(directory).list(), []);
    } finally { await provider.close(); }
  });
});

test('预置父级继承勾选（含未来新增与加盟店）会被清空且不会进入最终范围', { timeout: 30000 }, async () => {
  const provider = await createProvider();
  await withDirectory(async directory => {
    const browser = await openBrowser();
    try {
      // 用真实页面操作预置“东区父级继承”勾选，模拟人工容易误勾的场景。
      const setup = await browser.newPage();
      await setup.goto(provider.base + '/portal');
      await setup.locator('[data-branch="east"] input[data-inherit]').check();
      await setup.waitForFunction(() =>
        document.querySelector('#scope').textContent.includes('实际门店：A、B'));
      await setup.close();

      const result = await collectScope(provider.base, { storeIds: ['A', 'C'], kind: '直营' }, directory);
      assert.deepEqual(result.storeIds, ['A', 'C']);
      const payload = JSON.parse((await new Archive(directory).read(result.receipt)).toString('utf8'));
      assert.deepEqual(payload.ids.sort(), ['A', 'C']);
      // 流程清空后只留下两个叶子选择，且没有任何分支继承选择。
      const selection = await (await fetch(provider.base + '/selection')).json();
      assert.deepEqual(selection.selection.branches, []);
      assert.deepEqual(selection.selection.leaves.sort(), ['A', 'C']);
    } finally { await browser.close(); await provider.close(); }
  });
});

test('目录持续变化无法稳定确认时停止且不留收件', { timeout: 45000 }, async () => {
  const provider = await createProvider();
  await withDirectory(async directory => {
    try {
      const onPage = page => {
        let gets = 0;
        page.on('request', request => {
          if (request.url().endsWith('/selection') && request.method() === 'GET') {
            gets += 1;
            // 第 5 次 GET 为“核对范围”触发，每次尝试都让目录版本再变一次。
            if (gets === 5) {
              fetch(provider.base + '/_control', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ generation: provider.state.generation + 1 })
              }).catch(() => {});
            }
          }
        });
      };
      await assert.rejects(
        collectScope(provider.base, { storeIds: ['A', 'C'], kind: '直营' }, directory, { maxAttempts: 3, onPage }),
        error => {
          assert.ok(error instanceof ScopeDiscrepancyError);
          assert.match(error.message, /连续 3 次发生变化/);
          assert.equal(error.details.attempts, 3);
          return true;
        }
      );
      assert.deepEqual(await new Archive(directory).list(), []);
    } finally { await provider.close(); }
  });
});
