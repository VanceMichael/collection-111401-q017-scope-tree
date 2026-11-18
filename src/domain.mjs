import {capture} from './client.mjs';
import {openBrowser} from './browser.mjs';
import {collectScope} from './collector.mjs';

export async function receiveCurrent(base,directory){const metadata=await capture(base+'/tree',directory);const browser=await openBrowser();try{const page=await browser.newPage();await page.goto(base+'/portal');await page.locator('[data-branch]').first().waitFor();return {receipt:metadata.receipt.id,regions:await page.locator('[data-branch]').count(),caption:await page.locator('h1').textContent()};}finally{await browser.close();}}

// 按给定门店范围走浏览器领取：页面内完成选择、核对生效范围，再把导出资料交收件程序。
export async function receiveScoped(base,target,directory,options={}){
  return collectScope(base,target,directory,options);
}
