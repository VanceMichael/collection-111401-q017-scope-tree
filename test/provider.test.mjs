import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider } from '../provider/server.mjs';
import { receiveCurrent } from '../src/domain.mjs';
import { Archive } from '../src/archive.mjs';

async function controlled(provider, change) {
  const response = await fetch(provider.base + '/_control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) });
  assert.equal(response.status, 200);
}

test('现有业务入口真实收存来源资料并可重新打开', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'business-'));
  try {
    const result = await receiveCurrent(provider.base, directory);
    assert.ok(result);
    const archive = new Archive(directory);
    const receipts = await archive.list();
    assert.ok(receipts.length > 0);
    for (const receipt of receipts) assert.ok((await archive.read(receipt)).length > 0);
    assert.ok(provider.audit.some(request => !request.path.startsWith('/_')));
  } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('树的首层并不包含所有门店', async () => {
 const provider = await createProvider();
 try {
const root=await(await fetch(provider.base+'/tree')).json();assert.equal(root.nodes.length,2);assert.ok(root.nodes.every(node=>node.type==='branch'));const east=await(await fetch(provider.base+'/tree?parent=east')).json();assert.deepEqual(east.nodes.map(node=>node.id),['A','B']);
 } finally { await provider.close(); }
});

test('父级继承随目录更新扩大而叶子身份稳定', async () => {
 const provider = await createProvider();
 try {
await fetch(provider.base+'/selection',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'branch',id:'east',checked:true})});await controlled(provider,{generation:2});const data=await(await fetch(provider.base+'/selection')).json();assert.deepEqual(data.ids,['A','B','C','D']);
 } finally { await provider.close(); }
});

test('浏览器可以展开区域并显示真实范围', async () => {
 const provider = await createProvider();
 try {
const {openBrowser}=await import('../src/browser.mjs');const browser=await openBrowser();try{const page=await browser.newPage();await page.goto(provider.base+'/portal');await page.locator('[data-branch="east"] button').click();await page.locator('[data-store="A"]').waitFor();await page.locator('[data-store="A"]').check();await page.waitForFunction(()=>document.querySelector('#scope').textContent.includes('A'));assert.match(await page.locator('#scope').textContent(),/A/);}finally{await browser.close();}
 } finally { await provider.close(); }
});
